//! cl100k-style token estimation. Mirrors tokenizer.ts: UTF-16 code unit lengths
//! for word/other runs (JS `.length`), CJK per character, punctuation pieces.

fn is_cjk(c: char) -> bool {
  matches!(c as u32,
    0x4E00..=0x9FFF |
    0x3040..=0x30FF |
    0xAC00..=0xD7AF
  )
}

fn is_word_char(c: char) -> bool {
  c.is_ascii_alphanumeric() || c == '_'
}

fn is_punct(c: char) -> bool {
  matches!(c, ',' | '.' | ':' | ';' | '!' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | '`')
}

fn count_word_run(units: usize) -> u32 {
  if units <= 1 { 1 } else { ((units as u32) + 3) / 4 }
}

fn count_other_run(units: usize) -> u32 {
  if units <= 1 { 1 } else { (((units as u32) + 2) / 3).max(1) }
}

pub fn count_tokens(text: &str) -> usize {
  let mut total = 0usize;
  let mut run = RunKind::Empty;
  let mut run_utf16 = 0usize;

  for c in text.chars() {
    let kind = if is_cjk(c) {
      RunKind::Cjk
    } else if is_word_char(c) {
      RunKind::Word
    } else if is_punct(c) || c.is_whitespace() {
      RunKind::Boundary
    } else {
      RunKind::Other
    };
    match kind {
      RunKind::Boundary => {
        if is_punct(c) {
          total += 1;
        }
        flush(&mut total, &mut run, &mut run_utf16);
      }
      _ => {
        if kind != run && run != RunKind::Empty {
          flush(&mut total, &mut run, &mut run_utf16);
        }
        run = kind;
        if kind == RunKind::Cjk {
          total += 1;
          run = RunKind::Empty;
          run_utf16 = 0;
        } else {
          run_utf16 += c.len_utf16();
        }
      }
    }
  }
  flush(&mut total, &mut run, &mut run_utf16);
  total
}

#[derive(PartialEq, Clone, Copy)]
enum RunKind {
  Empty,
  Word,
  Other,
  Cjk,
  Boundary,
}

fn flush(total: &mut usize, run: &mut RunKind, run_utf16: &mut usize) {
  match *run {
    RunKind::Word => *total += count_word_run(*run_utf16) as usize,
    RunKind::Other => *total += count_other_run(*run_utf16) as usize,
    RunKind::Cjk | RunKind::Empty | RunKind::Boundary => {}
  }
  *run = RunKind::Empty;
  *run_utf16 = 0;
}

fn slice_utf16(s: &str, max_units: usize) -> String {
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

pub fn truncate_to_tokens(text: &str, max_tokens: u32) -> String {
  if max_tokens == 0 {
    return String::new();
  }
  if count_tokens(text) <= max_tokens as usize {
    return text.to_string();
  }
  let units = text.encode_utf16().count();
  let mut lo = 0usize;
  let mut hi = units;
  while lo < hi {
    let mid = (lo + hi + 1) / 2;
    if count_tokens(&slice_utf16(text, mid)) <= max_tokens as usize {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  slice_utf16(text, lo)
}
