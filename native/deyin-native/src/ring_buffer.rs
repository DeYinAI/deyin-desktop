//! Circular ring buffer for terminal logs.
//! Keeps the last N lines in memory with lock-free/low-contention reads.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

static GLOBAL_BUFFERS: OnceLock<RwLock<HashMap<String, Arc<Mutex<RingBufferInner>>>>> = OnceLock::new();

fn get_buffers() -> &'static RwLock<HashMap<String, Arc<Mutex<RingBufferInner>>>> {
  GLOBAL_BUFFERS.get_or_init(|| RwLock::new(HashMap::new()))
}

struct RingBufferInner {
  capacity: usize,
  lines: VecDeque<String>,
  total_appended: u64,
}

impl RingBufferInner {
  fn new(capacity: usize) -> Self {
    Self {
      capacity,
      lines: VecDeque::with_capacity(capacity.min(1000)),
      total_appended: 0,
    }
  }

  fn append(&mut self, line: String) {
    if self.lines.len() >= self.capacity {
      self.lines.pop_front();
    }
    self.lines.push_back(line);
    self.total_appended += 1;
  }

  fn get_lines(&self, max: Option<usize>) -> Vec<String> {
    match max {
      Some(limit) => {
        let count = self.lines.len();
        let skip = count.saturating_sub(limit);
        self.lines.iter().skip(skip).cloned().collect()
      }
      None => self.lines.iter().cloned().collect(),
    }
  }

  fn clear(&mut self) {
    self.lines.clear();
  }
}

fn get_or_create_buffer(buffer_id: &str, capacity: usize) -> Arc<Mutex<RingBufferInner>> {
  {
    let read_map = get_buffers().read().unwrap();
    if let Some(buf) = read_map.get(buffer_id) {
      return Arc::clone(buf);
    }
  }
  let mut write_map = get_buffers().write().unwrap();
  Arc::clone(write_map.entry(buffer_id.to_string()).or_insert_with(|| Arc::new(Mutex::new(RingBufferInner::new(capacity)))))
}

/// Append a line to a named ring buffer (creates with capacity if not present).
pub fn append_line(buffer_id: &str, line: String, capacity: usize) {
  let buf = get_or_create_buffer(buffer_id, capacity);
  let mut inner = buf.lock().unwrap();
  inner.append(line);
}

/// Get the recent lines from a named ring buffer.
pub fn get_recent_lines(buffer_id: &str, max_lines: Option<usize>) -> Vec<String> {
  let buf_opt = {
    let read_map = get_buffers().read().unwrap();
    read_map.get(buffer_id).cloned()
  };
  if let Some(buf) = buf_opt {
    let inner = buf.lock().unwrap();
    inner.get_lines(max_lines)
  } else {
    Vec::new()
  }
}

/// Get total appended count for a buffer.
pub fn get_total_appended(buffer_id: &str) -> u64 {
  let buf_opt = {
    let read_map = get_buffers().read().unwrap();
    read_map.get(buffer_id).cloned()
  };
  if let Some(buf) = buf_opt {
    let inner = buf.lock().unwrap();
    inner.total_appended
  } else {
    0
  }
}

/// Clear a named ring buffer.
pub fn clear_buffer(buffer_id: &str) {
  let buf_opt = {
    let read_map = get_buffers().read().unwrap();
    read_map.get(buffer_id).cloned()
  };
  if let Some(buf) = buf_opt {
    let mut inner = buf.lock().unwrap();
    inner.clear();
  }
}

/// Remove a named ring buffer from memory.
pub fn remove_buffer(buffer_id: &str) {
  let mut write_map = get_buffers().write().unwrap();
  write_map.remove(buffer_id);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_ring_buffer_eviction() {
    let id = "test-buf-1";
    clear_buffer(id);
    for i in 0..5 {
      append_line(id, format!("line {i}"), 3);
    }
    let lines = get_recent_lines(id, None);
    assert_eq!(lines, vec!["line 2", "line 3", "line 4"]);
    assert_eq!(get_total_appended(id), 5);
    remove_buffer(id);
  }
}
