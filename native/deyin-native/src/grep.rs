//! Parallel in-process grep with gitignore-style directory skips.
//! Supports a small regex subset + literal fallback; bounded workers with
//! early termination; symlink-cycle protection; optional case-insensitive mode.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

pub struct GrepHit {
  pub file: String,
  pub line_number: u32,
  pub line_text: String,
}

const SKIP_DIRS: &[&str] = &[
  "node_modules", ".git", "dist", "build", "out", ".next", ".cache",
  "target", "coverage", ".pnpm-store", "__pycache__", ".venv", "venv",
  "release", ".deyin",
];

const SKIP_FILE_NAMES: &[&str] = &[
  ".env", ".env.local", ".env.production", "credentials.json", "id_rsa", "id_ed25519",
];

const MAX_FILE_BYTES: u64 = 1_000_000;
const PER_FILE_MAX: usize = 20;
const FILE_BUDGET: usize = 20_000;

fn should_skip_dir(name: &str) -> bool {
  SKIP_DIRS.contains(&name) || (name.starts_with('.') && name != ".github" && name != ".vscode")
}

fn should_skip_file(name: &str) -> bool {
  SKIP_FILE_NAMES.contains(&name)
    || name.ends_with(".pem")
    || name.ends_with(".key")
    || name.contains("credentials")
}

/// Expand `{a,b}` alternation (mirrors agent-core `globToRegExp`).
fn expand_glob_braces(glob: &str) -> Vec<String> {
  match glob.find('{') {
    None => vec![glob.to_string()],
    Some(start) => {
      let end = match glob[start + 1..].find('}') {
        Some(off) => start + 1 + off,
        None => return vec![glob.to_string()],
      };
      let prefix = &glob[..start];
      let suffix = &glob[end + 1..];
      let inner = &glob[start + 1..end];
      let mut out = Vec::new();
      for opt in inner.split(',') {
        out.extend(expand_glob_braces(&format!("{prefix}{opt}{suffix}")));
      }
      out
    }
  }
}

/// Minimal glob matcher mirroring agent-core `matchGlob` (**, *, ?, `{a,b}`).
fn match_glob(rel: &str, glob: &str) -> bool {
  let normalized = rel.replace('\\', "/");
  let base = if glob.contains('/') {
    glob.to_string()
  } else {
    format!("**/{}", glob)
  };
  expand_glob_braces(&base)
    .iter()
    .any(|pat| glob_match_impl(&normalized, pat))
}

fn glob_match_impl(path: &str, glob: &str) -> bool {
  let mut gi = 0usize;
  let mut pi = 0usize;
  let g = glob.as_bytes();
  let p = path.as_bytes();
  fn rec(g: &[u8], p: &[u8], gi: usize, mut pi: usize) -> bool {
    if gi == g.len() {
      return pi == p.len();
    }
    if g[gi] == b'*' {
      if gi + 1 < g.len() && g[gi + 1] == b'*' {
        if gi + 2 < g.len() && g[gi + 2] == b'/' {
          let next = gi + 3;
          while pi <= p.len() {
            if rec(g, p, next, pi) {
              return true;
            }
            if pi >= p.len() {
              break;
            }
            pi += 1;
            while pi < p.len() && p[pi] != b'/' {
              pi += 1;
            }
          }
          return false;
        }
        for pi2 in pi..=p.len() {
          if rec(g, p, gi + 2, pi2) {
            return true;
          }
        }
        return false;
      }
      for pi2 in pi..=p.len() {
        if rec(g, p, gi + 1, pi2) {
          return true;
        }
        if pi2 < p.len() && p[pi2] == b'/' {
          break;
        }
      }
      return false;
    }
    if pi >= p.len() {
      return false;
    }
    if g[gi] == b'?' {
      if p[pi] == b'/' {
        return false;
      }
      return rec(g, p, gi + 1, pi + 1);
    }
    if g[gi] != p[pi] {
      return false;
    }
    rec(g, p, gi + 1, pi + 1)
  }
  rec(g, p, gi, pi)
}

#[derive(Clone)]
enum Node {
  Char(char),
  Any,
  Class(Vec<(char, char)>, bool),
  Star(Box<Node>),
  Plus(Box<Node>),
  Question(Box<Node>),
}

fn parse_pattern(pattern: &str) -> Option<Vec<Node>> {
  let mut nodes = Vec::new();
  let mut chars = pattern.chars().peekable();
  while let Some(c) = chars.next() {
    let atom = match c {
      '.' => Node::Any,
      '\\' => Node::Char(chars.next()?),
      '[' => {
        let mut ranges = Vec::new();
        let negated = if chars.peek() == Some(&'^') {
          chars.next();
          true
        } else {
          false
        };
        let mut first = true;
        loop {
          let n = chars.next()?;
          if n == ']' && !first {
            break;
          }
          first = false;
          if chars.peek() == Some(&'-') {
            chars.next();
            let hi = chars.next()?;
            ranges.push((n, hi));
          } else {
            ranges.push((n, n));
          }
        }
        Node::Class(ranges, negated)
      }
      '*' => {
        let last = nodes.pop()?;
        match last {
          Node::Char(ch) => Node::Star(Box::new(Node::Char(ch))),
          Node::Any => Node::Star(Box::new(Node::Any)),
          Node::Class(r, n) => Node::Star(Box::new(Node::Class(r, n))),
          other => {
            nodes.push(other);
            Node::Char('*')
          }
        }
      }
      '+' => {
        let last = nodes.pop()?;
        match last {
          Node::Char(ch) => Node::Plus(Box::new(Node::Char(ch))),
          Node::Any => Node::Plus(Box::new(Node::Any)),
          Node::Class(r, n) => Node::Plus(Box::new(Node::Class(r, n))),
          other => {
            nodes.push(other);
            Node::Char('+')
          }
        }
      }
      '?' => {
        let last = nodes.pop()?;
        match last {
          Node::Char(ch) => Node::Question(Box::new(Node::Char(ch))),
          Node::Any => Node::Question(Box::new(Node::Any)),
          Node::Class(r, n) => Node::Question(Box::new(Node::Class(r, n))),
          other => {
            nodes.push(other);
            Node::Char('?')
          }
        }
      }
      literal => Node::Char(literal),
    };
    nodes.push(atom);
  }
  Some(nodes)
}

fn as_literal(pattern: &str) -> Option<String> {
  if pattern
    .chars()
    .any(|c| matches!(c, '.' | '*' | '+' | '?' | '[' | '\\' | '^' | '$' | '(' | ')' | '|'))
  {
    None
  } else {
    Some(pattern.to_string())
  }
}

fn class_match(ranges: &[(char, char)], negated: bool, c: char) -> bool {
  let hit = ranges.iter().any(|(lo, hi)| c >= *lo && c <= *hi);
  hit != negated
}

fn match_here(nodes: &[Node], text: &[char], ti: usize) -> bool {
  if nodes.is_empty() {
    return true;
  }
  match &nodes[0] {
    Node::Char(c) => ti < text.len() && text[ti] == *c && match_here(&nodes[1..], text, ti + 1),
    Node::Any => ti < text.len() && match_here(&nodes[1..], text, ti + 1),
    Node::Class(ranges, neg) => {
      ti < text.len() && class_match(ranges, *neg, text[ti]) && match_here(&nodes[1..], text, ti + 1)
    }
    Node::Star(inner) => {
      let mut count = 0usize;
      while ti + count < text.len() && single_match(inner, text[ti + count]) {
        count += 1;
      }
      while count > 0 {
        if match_here(&nodes[1..], text, ti + count) {
          return true;
        }
        count -= 1;
      }
      match_here(&nodes[1..], text, ti)
    }
    Node::Plus(inner) => {
      let mut count = 0usize;
      while ti + count < text.len() && single_match(inner, text[ti + count]) {
        count += 1;
      }
      while count >= 1 {
        if match_here(&nodes[1..], text, ti + count) {
          return true;
        }
        count -= 1;
      }
      false
    }
    Node::Question(inner) => {
      if ti < text.len() && single_match(inner, text[ti]) && match_here(&nodes[1..], text, ti + 1) {
        return true;
      }
      match_here(&nodes[1..], text, ti)
    }
  }
}

fn single_match(node: &Node, c: char) -> bool {
  match node {
    Node::Char(x) => *x == c,
    Node::Any => true,
    Node::Class(ranges, neg) => class_match(ranges, *neg, c),
    _ => false,
  }
}

fn line_matches(
  pattern_nodes: Option<&Vec<Node>>,
  literal: Option<&str>,
  line: &str,
  ignore_case: bool,
) -> bool {
  if ignore_case {
    if let Some(lit) = literal {
      return line.to_ascii_lowercase().contains(&lit.to_ascii_lowercase());
    }
    if let Some(nodes) = pattern_nodes {
      let lower: Vec<char> = line.to_ascii_lowercase().chars().collect();
      for start in 0..=lower.len() {
        if match_here(nodes, &lower, start) {
          return true;
        }
      }
    }
    return false;
  }
  if let Some(lit) = literal {
    return line.contains(lit);
  }
  if let Some(nodes) = pattern_nodes {
    let chars: Vec<char> = line.chars().collect();
    for start in 0..=chars.len() {
      if match_here(nodes, &chars, start) {
        return true;
      }
    }
  }
  false
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>, budget: usize, visited: &mut HashSet<(u64, u64)>) {
  if out.len() >= budget {
    return;
  }
  let meta = match std::fs::metadata(dir) {
    Ok(m) => m,
    Err(_) => return,
  };
  #[cfg(unix)]
  {
    use std::os::unix::fs::MetadataExt;
    if !visited.insert((meta.dev(), meta.ino())) {
      return;
    }
  }
  #[cfg(not(unix))]
  {
    if let Ok(canon) = std::fs::canonicalize(dir) {
      if !visited.insert((0, canon.as_os_str() as *const _ as u64)) {
        return;
      }
    }
  }

  let entries = match std::fs::read_dir(dir) {
    Ok(e) => e,
    Err(_) => return,
  };
  let mut subdirs = Vec::new();
  for entry in entries.flatten() {
    if out.len() >= budget {
      return;
    }
    let path = entry.path();
    let name = entry.file_name().to_string_lossy().to_string();
    let file_type = entry.file_type().ok();
    let is_symlink = file_type.as_ref().map(|t| t.is_symlink()).unwrap_or(false);
    let is_dir = file_type.as_ref().map(|t| t.is_dir()).unwrap_or(false);
    if is_symlink {
      continue;
    }
    if is_dir {
      if !should_skip_dir(&name) {
        subdirs.push(path);
      }
    } else if !should_skip_file(&name) {
      out.push(path);
    }
  }
  for sd in subdirs {
    walk(&sd, out, budget, visited);
    if out.len() >= budget {
      return;
    }
  }
}

pub struct SearchOutcome {
  pub hits: Vec<GrepHit>,
  pub truncated: bool,
}

pub fn search(
  root: &str,
  pattern: &str,
  glob: Option<&str>,
  max_results: usize,
  ignore_case: bool,
) -> std::io::Result<SearchOutcome> {
  let pattern_owned = if ignore_case {
    pattern.to_ascii_lowercase()
  } else {
    pattern.to_string()
  };
  let nodes = parse_pattern(&pattern_owned);
  let literal = nodes
    .as_ref()
    .and_then(|_| as_literal(&pattern_owned))
    .or_else(|| {
      if nodes.is_none() {
        Some(pattern_owned.clone())
      } else {
        None
      }
    });

  let mut files = Vec::with_capacity(4096);
  let mut visited = HashSet::new();
  walk(Path::new(root), &mut files, FILE_BUDGET, &mut visited);

  let stop = Arc::new(AtomicBool::new(false));
  let sent = Arc::new(AtomicUsize::new(0));
  let workers = thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
  let chunk = (files.len() / workers).max(64);
  let (tx, rx) = mpsc::sync_channel::<GrepHit>(256);

  let mut handles = Vec::new();
  for slice in files.chunks(chunk.max(1)) {
    let owned: Vec<PathBuf> = slice.to_vec();
    let tx = tx.clone();
    let nodes = nodes.clone();
    let literal = literal.clone();
    let glob = glob.map(|g| g.to_string());
    let root_s = root.to_string();
    let stop = Arc::clone(&stop);
    let sent = Arc::clone(&sent);
    handles.push(thread::spawn(move || {
      for path in owned {
        if stop.load(Ordering::Relaxed) {
          return;
        }
        let rel = path
          .strip_prefix(&root_s)
          .unwrap_or(&path)
          .to_string_lossy()
          .to_string();
        if let Some(ref gf) = glob {
          if !match_glob(&rel, gf) {
            continue;
          }
        }
        let meta = match path.metadata() {
          Ok(m) => m,
          Err(_) => continue,
        };
        if meta.len() > MAX_FILE_BYTES || meta.len() == 0 {
          continue;
        }
        let content = match std::fs::read_to_string(&path) {
          Ok(c) => c,
          Err(_) => continue,
        };
        let mut file_hits = 0usize;
        for (i, line) in content.lines().enumerate() {
          if stop.load(Ordering::Relaxed) {
            return;
          }
          if file_hits >= PER_FILE_MAX {
            break;
          }
          if line_matches(nodes.as_ref(), literal.as_deref(), line, ignore_case) {
            file_hits += 1;
            let n = sent.fetch_add(1, Ordering::Relaxed);
            if n >= max_results {
              stop.store(true, Ordering::Relaxed);
              return;
            }
            if tx
              .send(GrepHit {
                file: rel.clone(),
                line_number: (i + 1) as u32,
                line_text: line.chars().take(400).collect(),
              })
              .is_err()
            {
              return;
            }
          }
        }
      }
    }));
  }
  drop(tx);

  let mut hits = Vec::new();
  let mut truncated = false;
  for hit in rx {
    if hits.len() >= max_results {
      truncated = true;
      stop.store(true, Ordering::Relaxed);
      break;
    }
    hits.push(hit);
  }
  if sent.load(Ordering::Relaxed) > max_results {
    truncated = true;
  }
  for h in handles {
    let _ = h.join();
  }
  Ok(SearchOutcome { hits, truncated })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn brace_glob_alternation() {
    assert!(match_glob("main.test.ts", "*.{test,spec}.ts"));
    assert!(match_glob("main.spec.ts", "*.{test,spec}.ts"));
    assert!(!match_glob("main.ts", "*.{test,spec}.ts"));
    assert!(!match_glob("mainXtest.ts", "*.{test,spec}.ts"));
  }

  #[test]
  fn nested_brace_expansion() {
    assert!(match_glob("a.ts", "*.{ts,tsx}"));
    assert!(match_glob("a.tsx", "*.{ts,tsx}"));
  }
}
