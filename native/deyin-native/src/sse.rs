//! Incremental SSE framing. One pass, zero regexes, no allocations beyond the
//! extracted payload strings.

pub enum LineOutcome {
  /// `event:`/`id:` lines and empty lines.
  KeepAlive,
  /// `data: [DONE]`.
  Done,
  /// Raw JSON text following `data:`.
  Payload(String),
}

/// Lightweight JSON validator (objects/arrays/strings/numbers/literals only).
/// Mirrors JS `JSON.parse` rejection for malformed SSE payloads — no external crate.
fn valid_json(payload: &str) -> bool {
  let bytes = payload.trim().as_bytes();
  if bytes.is_empty() {
    return false;
  }
  let mut i = 0usize;
  if parse_value(bytes, &mut i).is_err() {
    return false;
  }
  while i < bytes.len() && bytes[i].is_ascii_whitespace() {
    i += 1;
  }
  i == bytes.len()
}

fn parse_value(bytes: &[u8], i: &mut usize) -> Result<(), ()> {
  skip_ws(bytes, i);
  if *i >= bytes.len() {
    return Err(());
  }
  match bytes[*i] {
    b'{' => parse_object(bytes, i),
    b'[' => parse_array(bytes, i),
    b'"' => {
      parse_string(bytes, i)?;
      Ok(())
    }
    b't' if matches_literal(bytes, i, b"true") => Ok(()),
    b'f' if matches_literal(bytes, i, b"false") => Ok(()),
    b'n' if matches_literal(bytes, i, b"null") => Ok(()),
    b'-' | b'0'..=b'9' => parse_number(bytes, i),
    _ => Err(()),
  }
}

fn parse_object(bytes: &[u8], i: &mut usize) -> Result<(), ()> {
  if bytes[*i] != b'{' {
    return Err(());
  }
  *i += 1;
  skip_ws(bytes, i);
  if *i < bytes.len() && bytes[*i] == b'}' {
    *i += 1;
    return Ok(());
  }
  loop {
    skip_ws(bytes, i);
    if *i >= bytes.len() || bytes[*i] != b'"' {
      return Err(());
    }
    parse_string(bytes, i)?;
    skip_ws(bytes, i);
    if *i >= bytes.len() || bytes[*i] != b':' {
      return Err(());
    }
    *i += 1;
    parse_value(bytes, i)?;
    skip_ws(bytes, i);
    if *i >= bytes.len() {
      return Err(());
    }
    match bytes[*i] {
      b'}' => {
        *i += 1;
        return Ok(());
      }
      b',' => *i += 1,
      _ => return Err(()),
    }
  }
}

fn parse_array(bytes: &[u8], i: &mut usize) -> Result<(), ()> {
  if bytes[*i] != b'[' {
    return Err(());
  }
  *i += 1;
  skip_ws(bytes, i);
  if *i < bytes.len() && bytes[*i] == b']' {
    *i += 1;
    return Ok(());
  }
  loop {
    parse_value(bytes, i)?;
    skip_ws(bytes, i);
    if *i >= bytes.len() {
      return Err(());
    }
    match bytes[*i] {
      b']' => {
        *i += 1;
        return Ok(());
      }
      b',' => *i += 1,
      _ => return Err(()),
    }
  }
}

fn parse_string(bytes: &[u8], i: &mut usize) -> Result<(), ()> {
  if bytes[*i] != b'"' {
    return Err(());
  }
  *i += 1;
  while *i < bytes.len() {
    match bytes[*i] {
      b'"' => {
        *i += 1;
        return Ok(());
      }
      b'\\' => {
        *i += 1;
        if *i >= bytes.len() {
          return Err(());
        }
        *i += 1;
      }
      b if b < 0x20 => return Err(()),
      _ => *i += 1,
    }
  }
  Err(())
}

fn parse_number(bytes: &[u8], i: &mut usize) -> Result<(), ()> {
  if *i >= bytes.len() {
    return Err(());
  }
  if bytes[*i] == b'-' {
    *i += 1;
  }
  if *i >= bytes.len() {
    return Err(());
  }
  if bytes[*i] == b'0' {
    *i += 1;
  } else if bytes[*i].is_ascii_digit() {
    while *i < bytes.len() && bytes[*i].is_ascii_digit() {
      *i += 1;
    }
  } else {
    return Err(());
  }
  if *i < bytes.len() && bytes[*i] == b'.' {
    *i += 1;
    if *i >= bytes.len() || !bytes[*i].is_ascii_digit() {
      return Err(());
    }
    while *i < bytes.len() && bytes[*i].is_ascii_digit() {
      *i += 1;
    }
  }
  if *i < bytes.len() && (bytes[*i] == b'e' || bytes[*i] == b'E') {
    *i += 1;
    if *i < bytes.len() && (bytes[*i] == b'+' || bytes[*i] == b'-') {
      *i += 1;
    }
    if *i >= bytes.len() || !bytes[*i].is_ascii_digit() {
      return Err(());
    }
    while *i < bytes.len() && bytes[*i].is_ascii_digit() {
      *i += 1;
    }
  }
  Ok(())
}

fn matches_literal(bytes: &[u8], i: &mut usize, lit: &[u8]) -> bool {
  if *i + lit.len() > bytes.len() {
    return false;
  }
  if &bytes[*i..*i + lit.len()] != lit {
    return false;
  }
  *i += lit.len();
  true
}

fn skip_ws(bytes: &[u8], i: &mut usize) {
  while *i < bytes.len() && bytes[*i].is_ascii_whitespace() {
    *i += 1;
  }
}

/// Parse one SSE data line per the framing rules shared with sse.ts.
pub fn parse_data_line(line: &str) -> LineOutcome {
  let trimmed = line.trim_end_matches('\r').trim();
  if !trimmed.starts_with("data:") {
    return LineOutcome::KeepAlive;
  }
  let payload = trimmed[5..].trim();
  if payload == "[DONE]" {
    return LineOutcome::Done;
  }
  if payload.is_empty() {
    return LineOutcome::KeepAlive;
  }
  if !valid_json(payload) {
    return LineOutcome::KeepAlive;
  }
  LineOutcome::Payload(payload.to_string())
}

/// Frame one raw chunk appended to a carry-over buffer into complete lines.
/// Returns (payloads, remainder, is_done).
pub fn frame_chunk(buffer: &str, chunk: &str) -> (Vec<String>, String, bool) {
  let mut joined = String::with_capacity(buffer.len() + chunk.len());
  joined.push_str(buffer);
  joined.push_str(chunk);

  let mut payloads = Vec::new();
  let mut is_done = false;
  let mut start = 0usize;
  let bytes = joined.as_bytes();
  let mut i = 0usize;
  while i < bytes.len() {
    if bytes[i] == b'\n' {
      let line = &joined[start..i];
      match parse_data_line(line) {
        LineOutcome::Payload(p) => payloads.push(p),
        LineOutcome::Done => is_done = true,
        LineOutcome::KeepAlive => {}
      }
      start = i + 1;
    }
    i += 1;
  }
  let rest = joined[start..].to_string();
  (payloads, rest, is_done)
}

/// Parse trailing buffer when the stream ends (mirrors sse.ts flush).
pub fn flush_buffer(buffer: &str) -> (Option<String>, bool) {
  if buffer.is_empty() {
    return (None, false);
  }
  match parse_data_line(buffer) {
    LineOutcome::Payload(p) => (Some(p), false),
    LineOutcome::Done => (None, true),
    LineOutcome::KeepAlive => (None, false),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rejects_invalid_json() {
    assert!(!valid_json("not-json"));
    assert!(!valid_json("{"));
    assert!(valid_json(r#"{"a":1}"#));
    assert!(valid_json("[1,2,3]"));
  }

  #[test]
  fn done_line() {
    assert!(matches!(parse_data_line("data: [DONE]"), LineOutcome::Done));
    assert!(matches!(parse_data_line("data: not-json"), LineOutcome::KeepAlive));
  }
}
