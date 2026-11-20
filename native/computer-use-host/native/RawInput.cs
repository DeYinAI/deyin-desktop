namespace Deyin.ComputerUseHost;

public enum MouseButton
{
  Left,
  Right,
  Middle,
}

/// <summary>Bringing a window to the front, and knowing whether it is there.</summary>
internal static class Foreground
{
  /// <summary>True when the window, or a window it owns (a dialog, a menu), is the foreground window.</summary>
  public static bool Has(IntPtr window)
  {
    var root = Native.RootOf(window);
    var fg = Native.GetForegroundWindow();
    if (fg == IntPtr.Zero) return false;
    return Native.RootOf(fg) == root || Native.GetAncestor(fg, Native.GA_ROOTOWNER) == root;
  }

  /// <summary>
  /// Foreground-lock rules stop a background process from stealing focus; attaching to the current foreground
  /// thread's input queue is the supported way around that. The result is verified, never assumed.
  /// </summary>
  public static bool Activate(IntPtr window, int timeoutMs = 700)
  {
    var root = Native.RootOf(window);
    if (Has(root)) return true;
    if (Native.IsIconic(root)) Native.ShowWindow(root, Native.SW_RESTORE);

    var current = Native.GetForegroundWindow();
    var currentThread = current == IntPtr.Zero ? 0 : Native.GetWindowThreadProcessId(current, out _);
    var me = Native.GetCurrentThreadId();
    var attached = currentThread != 0 && currentThread != me && Native.AttachThreadInput(me, currentThread, true);
    try
    {
      Native.BringWindowToTop(root);
      Native.SetForegroundWindow(root);
    }
    finally
    {
      if (attached) Native.AttachThreadInput(me, currentThread, false);
    }

    var deadline = Environment.TickCount64 + timeoutMs;
    while (Environment.TickCount64 < deadline)
    {
      if (Has(root)) return true;
      Thread.Sleep(15);
    }
    return Has(root);
  }
}

/// <summary>Waits until an app has read the input that was sent to it.</summary>
internal static class InputDrain
{
  private const int SettleAfterEmptyMs = 40;

  /// <summary>
  /// Share the app's input queue for a moment and wait for it to report no pending keyboard or mouse input.
  /// Bounded: a hung or busy app costs at most <paramref name="maxMs"/>, then the caller carries on.
  /// </summary>
  public static void Wait(IntPtr window, int maxMs, CancellationToken ct, int settleMs = SettleAfterEmptyMs)
  {
    var targetThread = Native.GetWindowThreadProcessId(window, out _);
    var me = Native.GetCurrentThreadId();
    if (targetThread == 0 || targetThread == me) return;
    if (!Native.AttachThreadInput(me, targetThread, true))
    {
      Thread.Sleep(Math.Min(maxMs, 150)); // could not look; give the app a fixed moment instead
      return;
    }
    try
    {
      var deadline = Environment.TickCount64 + maxMs;
      var emptyReads = 0;
      while (Environment.TickCount64 < deadline && !ct.IsCancellationRequested)
      {
        var pending = Native.GetQueueStatus(Native.QS_INPUT) & 0xFFFF;
        emptyReads = pending == 0 ? emptyReads + 1 : 0;
        if (emptyReads >= 2) break;
        Thread.Sleep(8);
      }
    }
    finally
    {
      Native.AttachThreadInput(me, targetThread, false);
    }
    // The flag clears when the message is taken off the queue, not when the app has finished handling it.
    Thread.Sleep(settleMs);
  }
}

/// <summary>
/// The last rung of the action ladder: real mouse and keyboard input. It batches events into single SendInput
/// calls, verifies the target window will receive them, always releases anything it pressed, and puts the
/// cursor and the previous foreground window back when it is done.
/// </summary>
internal sealed class RawInputSession : IDisposable
{
  private readonly IntPtr _root;
  private readonly CancellationToken _ct;
  private readonly POINT _savedCursor;
  private readonly bool _hasSavedCursor;
  private readonly IntPtr _savedForeground;
  private readonly List<ushort> _heldKeys = new();
  private MouseButton? _heldButton;
  private bool _cursorMoved;
  private bool _focusChanged;
  private bool _sentInput;
  private bool _announced;
  private int _drainBudgetMs = 2000;
  private readonly InputWatch.Lease _lease;
  private readonly (int X, int Y, int Width, int Height) _desktop;

  /// <summary>Leave the cursor where the action put it (hover needs that); everything else restores it.</summary>
  public bool RestoreCursor { get; set; } = true;

  public bool CursorMoved => _cursorMoved;
  public bool FocusChanged => _focusChanged;

  /// <summary>How long the on-screen "controlling your computer" cue shows before the first real input.</summary>
  private const int CueMs = 150;

  public RawInputSession(IntPtr target, CancellationToken ct)
  {
    _root = Native.RootOf(target);
    _ct = ct;
    Native.ThrowIfInputBlocked(_root);
    _hasSavedCursor = Native.GetCursorPos(out _savedCursor);
    _savedForeground = Native.GetForegroundWindow();
    _desktop = Native.VirtualDesktop();
    _lease = InputWatch.Begin();
  }

  /// <summary>Stop if the action was cancelled or the user took over the mouse or keyboard.</summary>
  private void CheckLive()
  {
    if (_lease.TookOver) throw new UserTookOverException();
    _ct.ThrowIfCancellationRequested();
  }

  /// <summary>
  /// Tell the client the real mouse and keyboard are about to be used, and give it a moment to show that on
  /// screen before anything visible happens.
  /// </summary>
  private void Announce(int? x = null, int? y = null)
  {
    if (_announced) return;
    _announced = true;
    HostEvents.Raise("input", new { active = true, x, y });
    Pause(CueMs);
  }

  /* Targeting ---------------------------------------------------------------- */

  /// <summary>Keys go to the foreground window, so the target must be it. Never type into a window we could not reach.</summary>
  public void EnsureKeyboardFocus()
  {
    CheckLive();
    Announce();
    if (Foreground.Has(_root)) return;
    if (!Foreground.Activate(_root))
    {
      throw new InvalidOperationException(
        "Could not bring the window to the front because Windows refused to change focus. Ask the user to click the window once, then try again.");
    }
    _focusChanged = true;
    Pause(60);
  }

  /// <summary>A click lands on whatever is on top at that point. If something else is, raise the target or refuse.</summary>
  private void EnsureMouseTarget(int x, int y)
  {
    CheckLive();
    Announce(x, y);
    if (Native.IsIconic(_root))
    {
      Native.ShowWindow(_root, Native.SW_RESTORE);
      _focusChanged = true;
      Pause(150);
    }
    if (IsTargetAt(x, y)) return;
    EnsureKeyboardFocus();
    if (!IsTargetAt(x, y))
    {
      var hit = Native.WindowFromPoint(new POINT { X = x, Y = y });
      var title = hit == IntPtr.Zero ? "" : Native.TitleOf(Native.RootOf(hit));
      throw new InvalidOperationException(
        $"Another window{(string.IsNullOrWhiteSpace(title) ? "" : $" (\"{title}\")")} is on top of that point, so a click there would hit the wrong app.");
    }
  }

  private bool IsTargetAt(int x, int y)
  {
    var hit = Native.WindowFromPoint(new POINT { X = x, Y = y });
    if (hit == IntPtr.Zero) return false;
    var hitRoot = Native.RootOf(hit);
    if (hitRoot == _root) return true;
    // The app's own menus and popups are separate top-level windows owned by the same process.
    if (Native.ProcessIdOf(hitRoot) == Native.ProcessIdOf(_root)) return true;
    return (Native.GetWindowLongPtr(hitRoot, Native.GWL_EXSTYLE).ToInt64() & Native.WS_EX_TRANSPARENT) != 0;
  }

  /* Mouse -------------------------------------------------------------------- */

  public void MoveTo(int x, int y)
  {
    Send(MoveAbsolute(x, y));
    _cursorMoved = true;
  }

  public void Click(int x, int y, MouseButton button, int count, IReadOnlyList<ushort> modifiers)
  {
    EnsureMouseTarget(x, y);
    PressModifiers(modifiers);
    try
    {
      MoveTo(x, y);
      Pause(15);
      for (var i = 0; i < Math.Clamp(count, 1, 3); i++)
      {
        SetButton(button, down: true);
        Pause(12);
        SetButton(button, down: false);
        if (i < count - 1) Pause(40);
      }
      if (modifiers.Count > 0) Flush();
    }
    finally
    {
      ReleaseModifiers(modifiers);
    }
  }

  public void Hover(int x, int y)
  {
    EnsureMouseTarget(x, y);
    // Many UIs only react to a move that arrives after the cursor is already inside them.
    MoveTo(x - 1, y - 1);
    Pause(15);
    MoveTo(x, y);
  }

  public void Wheel(int x, int y, int deltaX, int deltaY)
  {
    EnsureMouseTarget(x, y);
    MoveTo(x, y);
    Pause(15);
    var inputs = new List<INPUT>();
    // One notch is 120 units; ~100 px per notch matches what a real wheel does.
    for (var i = 0; i < Notches(deltaY); i++) inputs.Add(WheelEvent(vertical: true, deltaY > 0 ? -120 : 120));
    for (var i = 0; i < Notches(deltaX); i++) inputs.Add(WheelEvent(vertical: false, deltaX > 0 ? 120 : -120));
    SendAll(inputs);
  }

  private static int Notches(int pixels) => pixels == 0 ? 0 : Math.Clamp((int)Math.Round(Math.Abs(pixels) / 100.0), 1, 40);

  public void Drag(int fromX, int fromY, int toX, int toY)
  {
    EnsureMouseTarget(fromX, fromY);
    MoveTo(fromX, fromY);
    Pause(20);
    SetButton(MouseButton.Left, down: true);
    try
    {
      Pause(30);
      const int steps = 10;
      for (var i = 1; i <= steps; i++)
      {
        MoveTo(fromX + (toX - fromX) * i / steps, fromY + (toY - fromY) * i / steps);
        Pause(12);
      }
      Pause(30);
    }
    finally
    {
      SetButton(MouseButton.Left, down: false);
    }
  }

  private void SetButton(MouseButton button, bool down)
  {
    var flag = (button, down) switch
    {
      (MouseButton.Left, true) => Native.MOUSEEVENTF_LEFTDOWN,
      (MouseButton.Left, false) => Native.MOUSEEVENTF_LEFTUP,
      (MouseButton.Right, true) => Native.MOUSEEVENTF_RIGHTDOWN,
      (MouseButton.Right, false) => Native.MOUSEEVENTF_RIGHTUP,
      (MouseButton.Middle, true) => Native.MOUSEEVENTF_MIDDLEDOWN,
      (MouseButton.Middle, false) => Native.MOUSEEVENTF_MIDDLEUP,
      _ => throw new InvalidOperationException($"Unsupported mouse button: {button}"),
    };
    _heldButton = down ? button : null;
    Send(MouseEvent(flag));
  }

  /* Keyboard ----------------------------------------------------------------- */

  /// <summary>Type text as Unicode key events in one batch (no per-character sleeps).</summary>
  public void TypeText(string text)
  {
    EnsureKeyboardFocus();
    var inputs = new List<INPUT>(text.Length * 2);
    for (var i = 0; i < text.Length; i++)
    {
      var ch = text[i];
      if (ch == '\r')
      {
        if (i + 1 < text.Length && text[i + 1] == '\n') continue; // CRLF: the LF below is the Enter
        inputs.Add(KeyEvent(Keys.VK_RETURN, up: false));
        inputs.Add(KeyEvent(Keys.VK_RETURN, up: true));
      }
      else if (ch == '\n')
      {
        inputs.Add(KeyEvent(Keys.VK_RETURN, up: false));
        inputs.Add(KeyEvent(Keys.VK_RETURN, up: true));
      }
      else if (ch == '\t')
      {
        inputs.Add(KeyEvent(Keys.VK_TAB, up: false));
        inputs.Add(KeyEvent(Keys.VK_TAB, up: true));
      }
      else
      {
        inputs.Add(UnicodeEvent(ch, up: false));
        inputs.Add(UnicodeEvent(ch, up: true));
      }
    }
    SendAll(inputs);
  }

  public void PressChord(KeyChord chord)
  {
    EnsureKeyboardFocus();
    _heldKeys.AddRange(chord.Modifiers);
    try
    {
      // A real keyboard has gaps between these events, and apps read the modifier state when they get to the key,
      // not when it was sent. Send the phases separately and let the app catch up between them, so the modifiers
      // are really held while the key is read.
      if (chord.Modifiers.Count > 0)
      {
        SendAll(chord.Modifiers.Select(m => KeyEvent(m, up: false)).ToList());
        Flush();
      }
      SendAll(new List<INPUT> { KeyEvent(chord.Vk, up: false), KeyEvent(chord.Vk, up: true) });
      if (chord.Modifiers.Count > 0) Flush();
      if (chord.Modifiers.Count > 0)
      {
        SendAll(chord.Modifiers.AsEnumerable().Reverse().Select(m => KeyEvent(m, up: true)).ToList());
      }
    }
    finally
    {
      _heldKeys.Clear();
    }
  }

  private void PressModifiers(IReadOnlyList<ushort> modifiers)
  {
    if (modifiers.Count == 0) return;
    _heldKeys.AddRange(modifiers);
    SendAll(modifiers.Select(m => KeyEvent(m, up: false)).ToList());
    Flush();
  }

  private void ReleaseModifiers(IReadOnlyList<ushort> modifiers)
  {
    if (modifiers.Count == 0) return;
    SendAll(modifiers.Reverse().Select(m => KeyEvent(m, up: true)).ToList(), checkCancel: false);
    foreach (var m in modifiers) _heldKeys.Remove(m);
  }

  /// <summary>Let the app read everything sent so far, so the next phase of a gesture sees its effects.</summary>
  private void Flush()
  {
    if (!_sentInput) return;
    InputDrain.Wait(_root, 600, _ct, settleMs: 15);
    CheckLive();
  }

  /* SendInput ------------------------------------------------------------------ */

  private void Send(INPUT input) => SendAll(new List<INPUT> { input });

  private void SendAll(List<INPUT> inputs, bool checkCancel = true)
  {
    if (inputs.Count > 0)
    {
      _sentInput = true;
      // A long typing run takes the app a while to work through; allow roughly a millisecond per event, up to 20 s.
      _drainBudgetMs = Math.Clamp(2000 + inputs.Count, 2000, 20000);
    }
    const int chunk = 256;
    for (var offset = 0; offset < inputs.Count; offset += chunk)
    {
      if (checkCancel) CheckLive();
      var batch = inputs.Skip(offset).Take(chunk).ToArray();
      var sent = Native.SendInput((uint)batch.Length, batch, Native.InputSize);
      if (sent != batch.Length)
      {
        throw new InvalidOperationException(
          $"Windows rejected the input (sent {sent} of {batch.Length} events). The target app may be running as administrator. Win32 error {System.Runtime.InteropServices.Marshal.GetLastWin32Error()}.");
      }
    }
  }

  private INPUT MoveAbsolute(int x, int y)
  {
    // Normalized 0..65535 over the whole virtual desktop, so multi-monitor and negative coordinates work.
    var cx = Math.Clamp(x, _desktop.X, _desktop.X + _desktop.Width - 1);
    var cy = Math.Clamp(y, _desktop.Y, _desktop.Y + _desktop.Height - 1);
    var nx = (int)Math.Round((cx - _desktop.X) * 65535.0 / Math.Max(1, _desktop.Width - 1));
    var ny = (int)Math.Round((cy - _desktop.Y) * 65535.0 / Math.Max(1, _desktop.Height - 1));
    return MouseEvent(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, nx, ny);
  }

  private static INPUT MouseEvent(uint flags, int dx = 0, int dy = 0, uint data = 0) => new()
  {
    type = Native.INPUT_MOUSE,
    U = new InputUnion { mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags } },
  };

  private static INPUT WheelEvent(bool vertical, int delta) =>
    MouseEvent(vertical ? Native.MOUSEEVENTF_WHEEL : Native.MOUSEEVENTF_HWHEEL, 0, 0, unchecked((uint)delta));

  private static INPUT KeyEvent(ushort vk, bool up)
  {
    var flags = (up ? Native.KEYEVENTF_KEYUP : 0u) | (Keys.IsExtended(vk) ? Native.KEYEVENTF_EXTENDEDKEY : 0u);
    return new INPUT
    {
      type = Native.INPUT_KEYBOARD,
      U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = (ushort)Native.MapVirtualKey(vk, 0), dwFlags = flags } },
    };
  }

  private static INPUT UnicodeEvent(char ch, bool up) => new()
  {
    type = Native.INPUT_KEYBOARD,
    U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = Native.KEYEVENTF_UNICODE | (up ? Native.KEYEVENTF_KEYUP : 0u) } },
  };

  /// <summary>Sleep that wakes immediately when the operation is cancelled or the user takes over.</summary>
  private void Pause(int milliseconds)
  {
    if (WaitHandle.WaitAny(new[] { _ct.WaitHandle, _lease.Signal }, milliseconds) != WaitHandle.WaitTimeout) CheckLive();
  }

  public void Dispose()
  {
    // Everything from here on is the host putting things back, not the user.
    _lease.Suspended = true;

    // Never leave a key or button held, even when cancelled or failing halfway.
    try
    {
      if (_heldButton is { } button) SetButton(button, down: false);
      if (_heldKeys.Count > 0)
      {
        SendAll(_heldKeys.AsEnumerable().Reverse().Select(k => KeyEvent(k, up: true)).ToList(), checkCancel: false);
        _heldKeys.Clear();
      }
    }
    catch
    {
      // best effort
    }

    try
    {
      // When the user took over, the pointer and the focus are theirs now: put nothing back.
      if (!_lease.TookOver) RestoreUserState();
    }
    finally
    {
      if (_announced) HostEvents.Raise("input", new { active = false });
      _lease.Dispose();
    }
  }

  private void RestoreUserState()
  {
    // SendInput only queues events. Restoring the cursor or the foreground window before the app has read them
    // changes what it sees (a deactivated app drops its modifier-key state: Ctrl+A arrives as a plain A, and an
    // app that asks where the cursor is on mouse-up gets the restored position).
    var restoring = (RestoreCursor && _cursorMoved && _hasSavedCursor) || _focusChanged;
    if (restoring && _sentInput) InputDrain.Wait(_root, _drainBudgetMs, _ct);

    if (RestoreCursor && _cursorMoved && _hasSavedCursor) Native.SetCursorPos(_savedCursor.X, _savedCursor.Y);

    // Give focus back only if the target is still in front; if the user already moved on, leave them alone.
    if (_focusChanged && _savedForeground != IntPtr.Zero && Native.IsWindow(_savedForeground)
        && Native.RootOf(_savedForeground) != _root && Foreground.Has(_root))
    {
      Foreground.Activate(_savedForeground, 400);
    }
  }
}
