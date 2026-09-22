//! High-throughput NDJSON (newline-delimited JSON) stream framing.
//! Consumes stdout/stderr chunks from headless CLIs (Claude Code, OpenAI Codex, OpenCode).

/// Frame a stream chunk into valid complete NDJSON lines.
/// Trims carriage returns and ignores empty lines.
pub fn frame_ndjson_chunk(buffer: &str, chunk: &str) -> (Vec<String>, String) {
  if buffer.is_empty() {
    let mut lines = Vec::new();
    let mut last_idx = 0;
    for (idx, byte) in chunk.bytes().enumerate() {
      if byte == b'\n' {
        let slice = &chunk[last_idx..idx];
        let trimmed = slice.trim();
        if !trimmed.is_empty() {
          lines.push(trimmed.to_string());
        }
        last_idx = idx + 1;
      }
    }
    let remainder = chunk[last_idx..].to_string();
    (lines, remainder)
  } else {
    let mut combined = String::with_capacity(buffer.len() + chunk.len());
    combined.push_str(buffer);
    combined.push_str(chunk);

    let mut lines = Vec::new();
    let mut last_idx = 0;

    for (idx, byte) in combined.bytes().enumerate() {
      if byte == b'\n' {
        let slice = &combined[last_idx..idx];
        let trimmed = slice.trim();
        if !trimmed.is_empty() {
          lines.push(trimmed.to_string());
        }
        last_idx = idx + 1;
      }
    }

    let remainder = combined[last_idx..].to_string();
    (lines, remainder)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_ndjson_framing() {
    let (lines, rest) = frame_ndjson_chunk("", "{\"type\":\"text-delta\",\"delta\":\"hi\"}\r\n{\"type\":\"done\"}\npartial");
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0], "{\"type\":\"text-delta\",\"delta\":\"hi\"}");
    assert_eq!(lines[1], "{\"type\":\"done\"}");
    assert_eq!(rest, "partial");
  }
}
