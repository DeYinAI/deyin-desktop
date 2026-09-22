//! Deyin's in-house native hot path. All algorithms implemented from scratch —
//! no third-party algorithm crates; napi is binding glue only.

pub mod acp_framing;
pub mod compress;
pub mod grep;
pub mod ndjson_framing;
pub mod process_watchdog;
pub mod ring_buffer;
pub mod sse;
pub mod tokenizer;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::time::{SystemTime, UNIX_EPOCH};

fn current_time_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis() as u64
}

/// Parse one SSE `data:` line.
/// Returns null for keep-alives/non-data lines, the string "[DONE]" sentinel is
/// signalled via `isDone`, otherwise `payload` holds raw JSON text (not parsed —
/// JSON parsing stays on the JS side where the objects are consumed).
#[napi(object)]
pub struct SseLineResult {
  pub payload: Option<String>,
  pub is_done: bool,
}

#[napi]
pub fn parse_sse_data_line(line: String) -> SseLineResult {
  match sse::parse_data_line(&line) {
    sse::LineOutcome::KeepAlive => SseLineResult { payload: None, is_done: false },
    sse::LineOutcome::Done => SseLineResult { payload: None, is_done: true },
    sse::LineOutcome::Payload(json) => SseLineResult { payload: Some(json), is_done: false },
  }
}

/// Frame a raw byte chunk into complete SSE data lines.
/// Returns the extracted payloads plus the trailing partial line to prepend
/// to the next chunk.
#[napi(object)]
pub struct SseChunkResult {
  pub payloads: Vec<String>,
  pub rest: String,
  pub is_done: bool,
}

#[napi]
pub fn frame_sse_chunk(buffer: String, chunk: String) -> SseChunkResult {
  let (payloads, rest, is_done) = sse::frame_chunk(&buffer, &chunk);
  SseChunkResult { payloads, rest, is_done }
}

#[napi(object)]
pub struct AcpChunkResult {
  pub payloads: Vec<String>,
  pub rest: String,
}

/// Frame a raw byte chunk into complete ACP JSON-RPC message lines.
#[napi]
pub fn frame_acp_chunk(buffer: String, chunk: String) -> AcpChunkResult {
  let (payloads, rest) = acp_framing::frame_acp_chunk(&buffer, &chunk);
  AcpChunkResult { payloads, rest }
}

/// Check if a line is a JSON-RPC 2.0 message.
#[napi]
pub fn is_json_rpc(line: String) -> bool {
  acp_framing::is_json_rpc(&line)
}

#[napi(object)]
pub struct NdjsonChunkResult {
  pub lines: Vec<String>,
  pub rest: String,
}

/// Frame a raw byte chunk into complete NDJSON lines (for Claude Code, Codex, OpenCode).
#[napi]
pub fn frame_ndjson_chunk(buffer: String, chunk: String) -> NdjsonChunkResult {
  let (lines, rest) = ndjson_framing::frame_ndjson_chunk(&buffer, &chunk);
  NdjsonChunkResult { lines, rest }
}

/// Append a line to a named terminal ring buffer.
#[napi]
pub fn ring_buffer_append(buffer_id: String, line: String, capacity: Option<u32>) {
  ring_buffer::append_line(&buffer_id, line, capacity.unwrap_or(10_000) as usize);
}

/// Get the recent lines from a named ring buffer.
#[napi]
pub fn ring_buffer_get_lines(buffer_id: String, max_lines: Option<u32>) -> Vec<String> {
  ring_buffer::get_recent_lines(&buffer_id, max_lines.map(|m| m as usize))
}

/// Clear a named terminal ring buffer.
#[napi]
pub fn ring_buffer_clear(buffer_id: String) {
  ring_buffer::clear_buffer(&buffer_id);
}

/// Remove a named terminal ring buffer from memory.
#[napi]
pub fn ring_buffer_remove(buffer_id: String) {
  ring_buffer::remove_buffer(&buffer_id);
}

/// Register a process with the high-resolution watchdog.
#[napi]
pub fn watchdog_register(
  id: String,
  pid: u32,
  timeout_ms: f64,
  stall_threshold_ms: f64,
  now_ms: Option<f64>,
) {
  let now = now_ms.map(|n| n as u64).unwrap_or_else(current_time_ms);
  process_watchdog::register(id, pid, timeout_ms as u64, stall_threshold_ms as u64, now);
}

/// Record a heartbeat or activity for a process in the watchdog.
#[napi]
pub fn watchdog_heartbeat(id: String, now_ms: Option<f64>) -> bool {
  let now = now_ms.map(|n| n as u64).unwrap_or_else(current_time_ms);
  process_watchdog::record_heartbeat(&id, now)
}

#[napi(object)]
pub struct WatchdogCheckResult {
  pub status: String,
  pub elapsed_ms: f64,
  pub inactive_ms: f64,
}

/// Check status of a process in the watchdog.
#[napi]
pub fn watchdog_check(id: String, now_ms: Option<f64>) -> WatchdogCheckResult {
  let now = now_ms.map(|n| n as u64).unwrap_or_else(current_time_ms);
  match process_watchdog::inspect(&id, now) {
    process_watchdog::WatchdogStatus::Running { elapsed_ms, inactive_ms } => WatchdogCheckResult {
      status: "running".to_string(),
      elapsed_ms: elapsed_ms as f64,
      inactive_ms: inactive_ms as f64,
    },
    process_watchdog::WatchdogStatus::Stalled { elapsed_ms, inactive_ms } => WatchdogCheckResult {
      status: "stalled".to_string(),
      elapsed_ms: elapsed_ms as f64,
      inactive_ms: inactive_ms as f64,
    },
    process_watchdog::WatchdogStatus::TimedOut { elapsed_ms } => WatchdogCheckResult {
      status: "timed-out".to_string(),
      elapsed_ms: elapsed_ms as f64,
      inactive_ms: 0.0,
    },
    process_watchdog::WatchdogStatus::NotFound => WatchdogCheckResult {
      status: "not-found".to_string(),
      elapsed_ms: 0.0,
      inactive_ms: 0.0,
    },
  }
}

/// Unregister a process from the watchdog.
#[napi]
pub fn watchdog_unregister(id: String) -> bool {
  process_watchdog::unregister(&id)
}

#[napi]
/// Count tokens using the built-in cl100k-style BPE approximation
/// (punctuation/whitespace pre-tokenization + CJK handling).
pub fn count_tokens(text: String) -> u32 {
  tokenizer::count_tokens(&text) as u32
}

/// Truncate text to at most `max_tokens` tokens without re-tokenizing from
/// scratch repeatedly (binary search over character lengths).
#[napi]
pub fn truncate_to_tokens(text: String, max_tokens: u32) -> String {
  tokenizer::truncate_to_tokens(&text, max_tokens)
}

#[napi(object)]
pub struct CompressResult {
  pub compressed: String,
  pub original_chars: u32,
  pub compressed_chars: u32,
}

/// Apply Deyin wire compression (ANSI strip, timestamp strip, duplicate
/// collapse, error prioritization). Mirrors compressToolOutput rules.
#[napi]
pub fn compress_wire_text(content: String, mode: String) -> CompressResult {
  compress_wire_text_ex(content, mode, Some("tool".to_string()), None)
}

/// Full-fidelity variant with the tool name (noisiness detection) and
/// preserveErrors flag.
#[napi]
pub fn compress_wire_text_ex(
  content: String,
  mode: String,
  tool_name: Option<String>,
  preserve_errors: Option<bool>,
) -> CompressResult {
  let original = content.encode_utf16().count();
  let out = compress::compress_tool_output(
    &content,
    tool_name.as_deref().unwrap_or("tool"),
    compress::Mode::parse(&mode),
    preserve_errors.unwrap_or(false),
  );
  let compressed_chars = out.encode_utf16().count();
  CompressResult {
    compressed: out,
    original_chars: original as u32,
    compressed_chars: compressed_chars as u32,
  }
}

#[napi(object)]
pub struct GrepMatch {
  pub file: String,
  pub line_number: u32,
  pub line_text: String,
}

#[napi(object)]
pub struct GrepResult {
  pub matches: Vec<GrepMatch>,
  pub truncated: bool,
}

/// Parallel regex search over a directory tree with .gitignore-style skips.
#[napi]
pub fn grep(
  root: String,
  pattern: String,
  glob: Option<String>,
  max_results: Option<u32>,
  ignore_case: Option<bool>,
) -> Result<GrepResult> {
  let outcome = grep::search(
    &root,
    &pattern,
    glob.as_deref(),
    max_results.unwrap_or(200) as usize,
    ignore_case.unwrap_or(false),
  )
  .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?;
  Ok(GrepResult {
    matches: outcome
      .hits
      .into_iter()
      .map(|h| GrepMatch {
        file: h.file,
        line_number: h.line_number,
        line_text: h.line_text,
      })
      .collect(),
    truncated: outcome.truncated,
  })
}
