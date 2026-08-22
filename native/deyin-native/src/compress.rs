//! Wire payload compression — faithful Rust port of agent-core's
//! compressToolOutput: ANSI/timestamp strip, consecutive-duplicate collapse
//! with markers, line capping, error-line prioritization, total cap.
//! Byte-for-byte compatible with the TS implementation.

pub enum Mode {
  Aggressive,
  Balanced,
  Conservative,
}

impl Mode {
  pub fn parse(s: &str) -> Mode {
    match s {
      "aggressive" => Mode::Aggressive,
      "conservative" => Mode::Conservative,
      _ => Mode::Balanced,
    }
  }

  fn caps(&self) -> (usize, usize, f64) {
    // (max_line, max_total, keep_log_ratio)
    match self {
      Mode::Aggressive => (240, 8_000, 0.25),
      Mode::Conservative => (800, 40_000, 0.6),
      Mode::Balanced => (480, 20_000, 0.4),
    }
  }
}

fn strip_ansi(line: &str) -> String {
  let mut out = String::with_capacity(line.len());
  let mut chars = line.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '\x1b' {
      if chars.peek() == Some(&'[') {
        chars.next();
        for n in chars.by_ref() {
          if n.is_ascii_alphabetic() {
            break;
          }
        }
        continue;
      }
      if chars.peek() == Some(&']') {
        chars.next();
        let mut prev = '\0';
        for n in chars.by_ref() {
          if n == '\x07' || (prev == '\x1b' && n == '\\') {
            break;
          }
          prev = n;
        }
        continue;
      }
      continue;
    }
    out.push(c);
  }
  out
}

/// Mirror TIMESTAMP_RE: ^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\s*
fn strip_timestamp(line: &mut String) {
  let b = line.as_bytes();
  let mut i = 0usize;
  // date part
  if b.len() < 19 {
    return;
  }
  for k in 0..10 {
    let c = b[k] as char;
    let ok = match k {
      4 | 7 => c == '-',
      _ => c.is_ascii_digit(),
    };
    if !ok {
      return;
    }
  }
  if b[10] != b'T' && b[10] != b' ' {
    return;
  }
  // time part HH:MM:SS
  for k in 11..19 {
    let c = b[k] as char;
    let ok = match k {
      13 | 16 => c == ':',
      _ => c.is_ascii_digit(),
    };
    if !ok {
      return;
    }
  }
  i = 19;
  // optional fractional .ddd+
  if i < b.len() && b[i] == b'.' {
    let mut j = i + 1;
    while j < b.len() && (b[j] as char).is_ascii_digit() {
      j += 1;
    }
    if j > i + 1 {
      i = j;
    }
  }
  // optional zone Z or ±HH:MM / ±HHMM
  if i < b.len() {
    match b[i] {
      b'Z' => i += 1,
      b'+' | b'-' => {
        let mut j = i + 1;
        while j < b.len() && ((b[j] as char).is_ascii_digit() || b[j] == b':') {
          j += 1;
        }
        if j >= i + 3 {
          i = j;
        }
      }
      _ => {}
    }
  }
  // trailing whitespace
  while i < b.len() && (b[i] as char).is_whitespace() {
    i += 1;
  }
  *line = line[i..].to_string();
}

/// Mirror ISO_PREFIX_RE: ^\[[\d:.]+\]\s*
fn strip_iso_prefix(line: &mut String) {
  if !line.starts_with('[') {
    return;
  }
  if let Some(close) = line.find(']') {
    let inner = &line[1..close];
    if !inner.is_empty() && inner.bytes().all(|c| c.is_ascii_digit() || c == b'.' || c == b':') {
      let mut rest = &line[close + 1..];
      rest = rest.trim_start();
      *line = rest.to_string();
    }
  }
}

fn collapse_spaces(line: &str) -> String {
  // MULTI_SPACE_RE: /[ \t]{2,}/g -> " "
  let mut out = String::with_capacity(line.len());
  let mut spaces = 0usize;
  for c in line.chars() {
    if c == ' ' || c == '\t' {
      spaces += 1;
    } else {
      if spaces >= 2 {
        out.push(' ');
      } else if spaces == 1 {
        out.push(if line[..].is_empty() { ' ' } else { ' ' });
      }
      spaces = 0;
      out.push(c);
    }
  }
  if spaces >= 2 {
    out.push(' ');
  } else if spaces == 1 {
    out.push(' ');
  }
  out
}

fn is_errorish(line: &str) -> bool {
  // ERROR_HINT_RE word-boundary check, case-insensitive (JS `\b` — `_` is word char).
  let lower = line.to_ascii_lowercase();
  ["error", "exception", "failed", "fatal", "panic", "traceback", "enoent", "eacces", "denied"]
    .iter()
    .any(|k| contains_word(&lower, k))
}

fn is_word_char(c: char) -> bool {
  c.is_ascii_alphanumeric() || c == '_'
}

fn contains_word(haystack: &str, needle: &str) -> bool {
  let bytes = haystack.as_bytes();
  let nb = needle.as_bytes();
  let mut start = 0usize;
  while let Some(pos) = find_sub(&bytes[start..], nb) {
    let abs = start + pos;
    let before_ok = abs == 0 || !is_word_char(bytes[abs - 1] as char);
    let after = abs + nb.len();
    let after_ok = after >= bytes.len() || !is_word_char(bytes[after] as char);
    if before_ok && after_ok {
      return true;
    }
    start = abs + 1;
    if start >= bytes.len() {
      break;
    }
  }
  false
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
  if needle.len() > haystack.len() {
    return None;
  }
  haystack.windows(needle.len()).position(|w| w == needle)
}

/// Mirror agent-core `detectContentType === "log"` signals.
fn looks_like_log(text: &str) -> bool {
  if text.contains('\x1b') {
    return true;
  }
  let lower = text.to_ascii_lowercase();
  if lower.contains("npm err") || lower.contains("npm warn") {
    return true;
  }
  for line in text.lines() {
    let t = line.trim_start();
    if t.starts_with("PASS")
      || t.starts_with("FAIL")
      || t.starts_with("ERROR")
      || t.starts_with("WARN")
      || t.starts_with("INFO")
      || t.starts_with("DEBUG")
    {
      return true;
    }
  }
  false
}

fn js_len(s: &str) -> usize {
  s.encode_utf16().count()
}

fn js_slice(s: &str, max_units: usize) -> String {
  let mut units = 0usize;
  let mut end = 0usize;
  for (i, c) in s.char_indices() {
    let u = c.len_utf16();
    if units + u > max_units {
      break;
    }
    units += u;
    end = i + c.len_utf8();
  }
  s[..end].to_string()
}

/// Mirror the TS isNoisy tool-name check:
/// /bash|shell|exec|terminal|npm|pnpm|yarn|pytest|jest/i
fn noisy_tool_name(tool_name: &str) -> bool {
  let lower = tool_name.to_ascii_lowercase();
  ["bash", "shell", "exec", "terminal", "npm", "pnpm", "yarn", "pytest", "jest"]
    .iter()
    .any(|k| lower.contains(k))
}

pub fn compress_tool_output(content: &str, tool_name: &str, mode: Mode, preserve_errors: bool) -> String {
  let (max_line, max_total, keep_ratio) = mode.caps();

  let stripped: Vec<String> = content
    .split('\n')
    .map(|raw| {
      let mut l = strip_ansi(raw);
      strip_timestamp(&mut l);
      strip_iso_prefix(&mut l);
      let collapsed = collapse_spaces(&l);
      collapsed.trim_end().to_string()
    })
    .collect();

  // Consecutive-duplicate collapse with omission markers.
  let mut deduped: Vec<String> = Vec::new();
  let mut prev = String::new();
  let mut repeat = 0usize;
  for line in stripped {
    if line == prev {
      repeat += 1;
      continue;
    }
    if repeat > 0 {
      let s = if repeat == 1 { "" } else { "s" };
      deduped.push(format!("… ({repeat} duplicate line{s} omitted)"));
      repeat = 0;
    }
    prev = line.clone();
    if js_len(&line) > max_line {
      let cut = js_slice(&line, max_line);
      deduped.push(format!("{cut}…"));
    } else {
      deduped.push(line);
    }
  }
  if repeat > 0 {
    let s = if repeat == 1 { "" } else { "s" };
    deduped.push(format!("… ({repeat} duplicate line{s} omitted)"));
  }

  let noisy = noisy_tool_name(tool_name) || looks_like_log(content);
  let mut kept = deduped;
  if noisy && !matches!(mode, Mode::Conservative) && kept.len() > 40 {
    let important: Vec<String> = kept.iter().filter(|l| is_errorish(l)).cloned().collect();
    let budget = (((kept.len() as f64) * keep_ratio).floor() as usize).max(20);
    if !important.is_empty() && (preserve_errors || important.len() < budget) {
      // preserveErrors: keep ALL error lines then fill remaining budget with
      // recent non-error lines — mirrors the TS branch exactly.
      let keep_errors = if preserve_errors {
        important
      } else {
        important.into_iter().take(budget).collect()
      };
      let filler_len = budget.saturating_sub(keep_errors.len());
      // TS: deduped.filter(non-error).slice(-(budget - keepErrors.length))
      let non_errors: Vec<&String> = kept.iter().filter(|l| !is_errorish(l)).collect();
      let skip = non_errors.len().saturating_sub(filler_len);
      let filler: Vec<String> = non_errors
        .into_iter()
        .skip(skip)
        .cloned()
        .collect();
      let mut combined = keep_errors;
      combined.extend(filler);
      kept = combined;
    } else {
      let start = kept.len().saturating_sub(budget);
      kept = kept.split_off(start);
    }
  }

  let mut out = kept.join("\n");
  while out.contains("\n\n\n") {
    out = out.replace("\n\n\n", "\n\n");
  }
  let out = out.trim().to_string();
  let out = if js_len(&out) > max_total {
    let cut = js_slice(&out, max_total);
    format!("{cut}\n… [tool output truncated]")
  } else {
    out
  };

  // Expansion guard (mirrors result() — UTF-16 lengths like JS `.length`).
  if js_len(&out) > js_len(content) * 3 / 2 && js_len(&out) > js_len(content) + 80 {
    content.to_string()
  } else {
    out
  }
}
