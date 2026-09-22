//! Zero-copy ACP (Agent Client Protocol) and JSON-RPC stream framing.
//! Handles stdio streams from external ACP agents (Zed ACP, Claude ACP, Codex ACP, OpenCode ACP).

/// Frame a stream chunk into complete ACP JSON-RPC message strings.
/// Returns extracted message lines plus any incomplete trailing bytes to buffer.
pub fn frame_acp_chunk(buffer: &str, chunk: &str) -> (Vec<String>, String) {
  if buffer.is_empty() {
    let mut messages = Vec::new();
    let mut last_idx = 0;
    for (idx, byte) in chunk.bytes().enumerate() {
      if byte == b'\n' {
        let slice = &chunk[last_idx..idx];
        let trimmed = slice.trim();
        if !trimmed.is_empty() {
          messages.push(trimmed.to_string());
        }
        last_idx = idx + 1;
      }
    }
    let remainder = chunk[last_idx..].to_string();
    (messages, remainder)
  } else {
    let mut combined = String::with_capacity(buffer.len() + chunk.len());
    combined.push_str(buffer);
    combined.push_str(chunk);

    let mut messages = Vec::new();
    let mut last_idx = 0;

    for (idx, byte) in combined.bytes().enumerate() {
      if byte == b'\n' {
        let slice = &combined[last_idx..idx];
        let trimmed = slice.trim();
        if !trimmed.is_empty() {
          messages.push(trimmed.to_string());
        }
        last_idx = idx + 1;
      }
    }

    let remainder = combined[last_idx..].to_string();
    (messages, remainder)
  }
}

/// Fast heuristic to check if a payload line is a valid JSON-RPC 2.0 envelope
pub fn is_json_rpc(line: &str) -> bool {
  let trimmed = line.trim();
  if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
    return false;
  }
  trimmed.contains("\"jsonrpc\"") && trimmed.contains("\"2.0\"")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_frame_acp_single_line() {
    let (msgs, rest) = frame_acp_chunk("", "{\"jsonrpc\":\"2.0\",\"id\":1}\n");
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0], "{\"jsonrpc\":\"2.0\",\"id\":1}");
    assert_eq!(rest, "");
  }

  #[test]
  fn test_frame_acp_split_chunks() {
    let (msgs1, rest1) = frame_acp_chunk("", "{\"jsonrpc\":\"2.0\",");
    assert!(msgs1.is_empty());
    assert_eq!(rest1, "{\"jsonrpc\":\"2.0\",");

    let (msgs2, rest2) = frame_acp_chunk(&rest1, "\"method\":\"session/update\"}\n{\"next\":1}");
    assert_eq!(msgs2.len(), 1);
    assert_eq!(msgs2[0], "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\"}");
    assert_eq!(rest2, "{\"next\":1}");
  }

  #[test]
  fn test_is_json_rpc() {
    assert!(is_json_rpc("{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\"}"));
    assert!(!is_json_rpc("regular log message"));
    assert!(!is_json_rpc("{\"other\":\"json\"}"));
  }
}
