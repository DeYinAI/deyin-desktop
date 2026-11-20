using System.Runtime.ExceptionServices;
using System.Windows.Automation;

namespace Deyin.ComputerUseHost;

/// <summary>What an action did and how, so the model (and the user) can tell a quiet action from a loud one.</summary>
public sealed record ActionOutcome(
  bool Ok,
  /// <summary>"uia" (accessibility pattern), "msg" (window message), or "input" (real mouse/keyboard).</summary>
  string Method,
  string? Detail = null,
  bool? CursorMoved = null,
  bool? FocusChanged = null);

internal sealed record ClickRequest(MouseButton Button, int Count, IReadOnlyList<ushort> Modifiers, string Method)
{
  public bool IsPlainLeftClick => Button == MouseButton.Left && Count == 1 && Modifiers.Count == 0;
}

/// <summary>
/// The quiet-first action ladder. Each action tries the least intrusive mechanism that can do it.
///
/// Window messages come first for classic Win32 controls: they reach the control without touching the cursor or
/// the foreground window. (Measured: UI Automation's Invoke, Toggle and SetValue on those same controls make the
/// app take the foreground a few milliseconds later, so UIA is the second choice there.) UI Automation patterns
/// are the first choice for everything else (WPF, UWP, Chromium), wrapped so that if the app does grab the
/// foreground the previous window is put back and the result says so. Real mouse and keyboard input is last.
/// </summary>
internal sealed class UiaActions
{
  private const int PatternTimeoutMs = 2000;
  private const int MessageTimeoutMs = 1500;
  /// <summary>How long to watch for an app grabbing the foreground after a UIA action returns (observed: 15-30 ms).</summary>
  private const int ForegroundWatchMs = 120;

  /// <summary>Classic Win32 controls that handle posted mouse messages the way a real click does.</summary>
  private static readonly HashSet<string> ClassicClickClasses = new(StringComparer.OrdinalIgnoreCase)
  {
    "Button", "ComboBox", "ComboLBox", "ListBox", "SysListView32", "SysTreeView32", "SysTabControl32",
    "ToolbarWindow32", "msctls_trackbar32", "msctls_updown32", "ScrollBar", "Static", "SysLink", "SysHeader32",
    "SysDateTimePick32", "SysMonthCal32", "ReBarWindow32",
  };

  /// <summary>Text controls that accept WM_CHAR and WM_SETTEXT without being focused.</summary>
  private static readonly HashSet<string> TextClasses = new(StringComparer.OrdinalIgnoreCase)
  {
    "Edit", "RichEdit20W", "RichEdit20A", "RICHEDIT50W", "RichEditD2DPT",
  };

  /* Clicking ------------------------------------------------------------------- */

  private const string OutOfView =
    "That element is scrolled out of view (it has no on-screen position). Scroll it into view, then try again.";

  public ActionOutcome Click(IntPtr hwnd, AutomationElement? element, POINT? point, ClickRequest request, CancellationToken ct)
  {
    var method = request.Method;
    if (method == "msg" && request.Modifiers.Count > 0)
    {
      throw new InvalidOperationException("Modifier keys (ctrl, shift, alt) can only be held with real input. Use method=input.");
    }

    if (method is "auto" or "msg" && request.Modifiers.Count == 0 && point is { } clickPoint)
    {
      var viaMessage = TryPostedClick(hwnd, element, clickPoint, request);
      if (viaMessage is not null) return viaMessage;
    }
    if (method == "msg")
    {
      throw new InvalidOperationException("That control is not a classic Win32 control, so a posted click cannot reach it. Use method=input.");
    }

    if (element is not null && request.IsPlainLeftClick && method is "auto" or "uia")
    {
      var viaPattern = Guarded(hwnd, () => TryActivate(element, ct));
      if (viaPattern is not null) return viaPattern;
      if (method == "uia")
      {
        throw new InvalidOperationException(
          "That element has no accessibility action (invoke, toggle, select or expand). Use method=input, or click by coordinates.");
      }
    }

    var screenPoint = point ?? throw new InvalidOperationException(OutOfView);
    using var raw = new RawInputSession(hwnd, ct);
    raw.Click(screenPoint.X, screenPoint.Y, request.Button, request.Count, request.Modifiers);
    return new ActionOutcome(true, "input", null, raw.CursorMoved, raw.FocusChanged);
  }

  /// <summary>Invoke, toggle, select or expand the element (or the control that contains it).</summary>
  private ActionOutcome? TryActivate(AutomationElement element, CancellationToken ct)
  {
    var current = element;
    for (var hop = 0; hop < 4 && current is not null; hop++)
    {
      ct.ThrowIfCancellationRequested();
      var outcome = TryPatterns(current);
      if (outcome is not null) return outcome;
      // Only look up through plain wrappers (text or an icon inside a button), never through containers.
      var role = SafeRole(current);
      if (hop == 0 && !(role is "Text" or "Image" or "Group" or "Pane" or "Custom")) return null;
      try
      {
        current = TreeWalker.ControlViewWalker.GetParent(current);
      }
      catch (ElementNotAvailableException)
      {
        return null;
      }
      if (current is not null && !IsInteractive(SafeRole(current))) return null;
    }
    return null;
  }

  private static ActionOutcome? TryPatterns(AutomationElement el)
  {
    try
    {
      if (el.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke))
      {
        var finished = RunBounded(() => ((InvokePattern)invoke).Invoke(), PatternTimeoutMs);
        return new ActionOutcome(true, "uia", finished ? "Invoke" : "Invoke (the app is busy or opened a dialog)", false, false);
      }
      if (el.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle))
      {
        RunBounded(() => ((TogglePattern)toggle).Toggle(), PatternTimeoutMs);
        return new ActionOutcome(true, "uia", "Toggle", false, false);
      }
      if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection))
      {
        RunBounded(() => ((SelectionItemPattern)selection).Select(), PatternTimeoutMs);
        return new ActionOutcome(true, "uia", "Select", false, false);
      }
      if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expand))
      {
        var pattern = (ExpandCollapsePattern)expand;
        var state = pattern.Current.ExpandCollapseState;
        if (state == ExpandCollapseState.Collapsed || state == ExpandCollapseState.PartiallyExpanded)
        {
          RunBounded(pattern.Expand, PatternTimeoutMs);
          return new ActionOutcome(true, "uia", "Expand", false, false);
        }
        if (state == ExpandCollapseState.Expanded)
        {
          RunBounded(pattern.Collapse, PatternTimeoutMs);
          return new ActionOutcome(true, "uia", "Collapse", false, false);
        }
      }
    }
    catch (ElementNotAvailableException)
    {
      throw new InvalidOperationException("That element no longer exists (the UI changed). Call get_state to re-observe.");
    }
    catch (InvalidOperationException ex) when (ex.Message.Contains("not enabled", StringComparison.OrdinalIgnoreCase))
    {
      throw new InvalidOperationException("That control is disabled.");
    }
    return null;
  }

  /// <summary>Post a click to a classic Win32 control: no focus change, no cursor movement.</summary>
  private static ActionOutcome? TryPostedClick(IntPtr topWindow, AutomationElement? element, POINT screenPoint, ClickRequest request)
  {
    if (request.Count > 2) return null; // classic windows have no triple-click message
    var target = FindWindowForPoint(topWindow, element, screenPoint, ClassicClickClasses);
    if (target == IntPtr.Zero) return null;
    if (!Native.IsWindowEnabled(target)) throw new InvalidOperationException("That control is disabled.");

    Native.ThrowIfInputBlocked(target);

    // A button takes the mouse capture on button-down, which a synthetic message cannot get, so a posted
    // down/up pair never completes the click. BM_CLICK is the button's own "click yourself" message.
    if (Native.ControlClassOf(target).Equals("Button", StringComparison.OrdinalIgnoreCase))
    {
      if (request.Button != MouseButton.Left || request.Count != 1) return null;
      Native.PostMessage(target, Native.BM_CLICK, IntPtr.Zero, IntPtr.Zero);
      return new ActionOutcome(true, "msg", "BM_CLICK", false, false);
    }

    var client = screenPoint;
    Native.ScreenToClient(target, ref client);
    var lParam = new IntPtr(Native.MakeLParam(client.X, client.Y));

    var (down, up, dbl, button) = request.Button switch
    {
      MouseButton.Right => (Native.WM_RBUTTONDOWN, Native.WM_RBUTTONUP, Native.WM_RBUTTONDBLCLK, Native.MK_RBUTTON),
      MouseButton.Middle => (Native.WM_MBUTTONDOWN, Native.WM_MBUTTONUP, Native.WM_MBUTTONDBLCLK, Native.MK_MBUTTON),
      _ => (Native.WM_LBUTTONDOWN, Native.WM_LBUTTONUP, Native.WM_LBUTTONDBLCLK, Native.MK_LBUTTON),
    };
    var keys = request.Modifiers.Aggregate(0, (acc, m) => acc | (m == Keys.VK_SHIFT ? Native.MK_SHIFT : m == Keys.VK_CONTROL ? Native.MK_CONTROL : 0));

    Native.PostMessage(target, Native.WM_MOUSEMOVE, IntPtr.Zero, lParam);
    Native.PostMessage(target, down, new IntPtr(button | keys), lParam);
    Native.PostMessage(target, up, new IntPtr(keys), lParam);
    if (request.Count == 2)
    {
      Native.PostMessage(target, dbl, new IntPtr(button | keys), lParam);
      Native.PostMessage(target, up, new IntPtr(keys), lParam);
    }
    return new ActionOutcome(true, "msg", $"posted to {Native.ClassNameOf(target)}", false, false);
  }

  /* Typing --------------------------------------------------------------------- */

  public ActionOutcome TypeText(IntPtr hwnd, AutomationElement? element, string text, string method, CancellationToken ct)
  {
    if (method is "auto" or "msg")
    {
      var target = FindTextWindow(hwnd, element);
      if (target != IntPtr.Zero)
      {
        RequireWritable(target);
        Native.ThrowIfInputBlocked(target);
        SendChars(target, text, ct);
        return new ActionOutcome(true, "msg", $"WM_CHAR to {Native.ClassNameOf(target)}", false, false);
      }
      if (method == "msg") throw new InvalidOperationException("No classic text control to send characters to. Use method=input.");
    }

    using var raw = new RawInputSession(hwnd, ct);
    raw.EnsureKeyboardFocus();
    if (element is not null) FocusElement(element, raw, ct);
    raw.TypeText(text);
    return new ActionOutcome(true, "input", null, raw.CursorMoved, raw.FocusChanged);
  }

  /// <summary>Focus an element with UI Automation; if it refuses, click it the way a user would.</summary>
  private static void FocusElement(AutomationElement element, RawInputSession raw, CancellationToken ct)
  {
    try
    {
      element.SetFocus();
      return;
    }
    catch (Exception ex) when (ex is InvalidOperationException or ElementNotAvailableException)
    {
      // not focusable through UIA
    }
    var rect = element.Current.BoundingRectangle;
    ct.ThrowIfCancellationRequested();
    raw.Click((int)(rect.X + rect.Width / 2), (int)(rect.Y + rect.Height / 2), MouseButton.Left, 1, Array.Empty<ushort>());
  }

  private static void SendChars(IntPtr target, string text, CancellationToken ct)
  {
    for (var i = 0; i < text.Length; i++)
    {
      if ((i & 0x3F) == 0) ct.ThrowIfCancellationRequested();
      var ch = text[i];
      if (ch == '\r' && i + 1 < text.Length && text[i + 1] == '\n') continue;
      var code = ch == '\n' ? '\r' : ch;
      // Synchronous send: back-pressure instead of overflowing the target's 10,000-message queue.
      Native.SendMessageTimeoutPtr(target, Native.WM_CHAR, new IntPtr(code), IntPtr.Zero, Native.SMTO_ABORTIFHUNG, MessageTimeoutMs, out _);
    }
  }

  /* Setting values --------------------------------------------------------------- */

  public ActionOutcome SetValue(IntPtr hwnd, AutomationElement element, string value, CancellationToken ct)
  {
    // Classic text control: one message sets it, with no focus change at all.
    var textWindow = FindTextWindow(hwnd, element);
    if (textWindow != IntPtr.Zero)
    {
      RequireWritable(textWindow);
      Native.ThrowIfInputBlocked(textWindow);
      Native.SendMessageTimeout(textWindow, Native.WM_SETTEXT, IntPtr.Zero, value, Native.SMTO_ABORTIFHUNG, MessageTimeoutMs, out _);
      return new ActionOutcome(true, "msg", $"WM_SETTEXT to {Native.ClassNameOf(textWindow)}", false, false);
    }

    var viaPattern = Guarded(hwnd, () => TrySetValuePattern(element, value));
    if (viaPattern is not null) return viaPattern;

    // Nothing quiet can write this control: focus it, select everything and type over it.
    using var raw = new RawInputSession(hwnd, ct);
    raw.EnsureKeyboardFocus();
    FocusElement(element, raw, ct);
    raw.PressChord(Keys.ParseChord("ctrl+a"));
    if (value.Length == 0) raw.PressChord(Keys.ParseChord("delete"));
    else raw.TypeText(value);
    return new ActionOutcome(true, "input", "select-all and type", raw.CursorMoved, raw.FocusChanged);
  }

  private static ActionOutcome? TrySetValuePattern(AutomationElement element, string value)
  {
    try
    {
      if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern) && pattern is ValuePattern valuePattern)
      {
        if (valuePattern.Current.IsReadOnly) throw new InvalidOperationException("That field is read-only.");
        RunBounded(() => valuePattern.SetValue(value), PatternTimeoutMs);
        return new ActionOutcome(true, "uia", "ValuePattern", false, false);
      }
    }
    catch (ElementNotAvailableException)
    {
      throw new InvalidOperationException("That element no longer exists (the UI changed). Call get_state to re-observe.");
    }
    return null;
  }

  /// <summary>A read-only edit control silently ignores typed characters; say so instead of pretending it worked.</summary>
  private static void RequireWritable(IntPtr edit)
  {
    if (!Native.IsWindowEnabled(edit)) throw new InvalidOperationException("That field is disabled.");
    if ((Native.GetWindowLongPtr(edit, Native.GWL_STYLE).ToInt64() & Native.ES_READONLY) != 0)
    {
      throw new InvalidOperationException("That field is read-only.");
    }
  }

  /* Keys ------------------------------------------------------------------------ */

  public ActionOutcome PressKey(IntPtr hwnd, KeyChord chord, CancellationToken ct)
  {
    // Chords need the real keyboard state (apps read Ctrl/Shift/Alt asynchronously), so this is always real input.
    using var raw = new RawInputSession(hwnd, ct);
    raw.PressChord(chord);
    return new ActionOutcome(true, "input", chord.Display, raw.CursorMoved, raw.FocusChanged);
  }

  /* Scrolling -------------------------------------------------------------------- */

  public ActionOutcome Scroll(IntPtr hwnd, AutomationElement? element, POINT? point, int deltaX, int deltaY, string method, CancellationToken ct)
  {
    if (method is "auto" or "uia")
    {
      var scrolled = Guarded(hwnd, () => TryScrollPattern(hwnd, element, point, deltaX, deltaY, ct));
      if (scrolled is not null) return scrolled;
      if (method == "uia") throw new InvalidOperationException("Nothing scrollable through accessibility is under that point. Use method=input.");
    }

    var wheelPoint = point ?? throw new InvalidOperationException(OutOfView);
    using var raw = new RawInputSession(hwnd, ct);
    raw.Wheel(wheelPoint.X, wheelPoint.Y, deltaX, deltaY);
    return new ActionOutcome(true, "input", "mouse wheel", raw.CursorMoved, raw.FocusChanged);
  }

  private static ActionOutcome? TryScrollPattern(IntPtr hwnd, AutomationElement? element, POINT? point, int deltaX, int deltaY, CancellationToken ct)
  {
    AutomationElement? start = element;
    if (start is null && point is { } at)
    {
      try
      {
        start = AutomationElement.FromPoint(new System.Windows.Point(at.X, at.Y));
      }
      catch (Exception ex) when (ex is ElementNotAvailableException or System.Runtime.InteropServices.COMException)
      {
        return null;
      }
    }
    if (start is null) return null;
    // Never scroll something that belongs to a different window than the one we were asked about.
    if (SafeProcessId(start) != (int)Native.ProcessIdOf(hwnd)) return null;

    var current = start;
    for (var hop = 0; hop < 10 && current is not null; hop++)
    {
      ct.ThrowIfCancellationRequested();
      try
      {
        if (current.TryGetCurrentPattern(ScrollPattern.Pattern, out var obj) && obj is ScrollPattern pattern)
        {
          var needV = deltaY != 0;
          var needH = deltaX != 0;
          var canV = pattern.Current.VerticallyScrollable;
          var canH = pattern.Current.HorizontallyScrollable;
          if ((needV && canV) || (needH && canH))
          {
            var beforeV = pattern.Current.VerticalScrollPercent;
            var beforeH = pattern.Current.HorizontalScrollPercent;
            var viewHeight = Math.Max(1, (int)current.Current.BoundingRectangle.Height);
            var viewWidth = Math.Max(1, (int)current.Current.BoundingRectangle.Width);
            var (vAmount, vSteps) = Amount(deltaY, viewHeight, vertical: true);
            var (hAmount, hSteps) = Amount(deltaX, viewWidth, vertical: false);
            for (var i = 0; i < Math.Max(vSteps, hSteps); i++)
            {
              ct.ThrowIfCancellationRequested();
              pattern.Scroll(i < hSteps && canH ? hAmount : ScrollAmount.NoAmount, i < vSteps && canV ? vAmount : ScrollAmount.NoAmount);
            }
            var afterV = pattern.Current.VerticalScrollPercent;
            var afterH = pattern.Current.HorizontalScrollPercent;
            return new ActionOutcome(
              true,
              "uia",
              $"ScrollPattern: vertical {beforeV:0.#}% -> {afterV:0.#}%{(needH ? $", horizontal {beforeH:0.#}% -> {afterH:0.#}%" : "")}",
              false,
              false);
          }
        }
        current = TreeWalker.ControlViewWalker.GetParent(current);
      }
      catch (ElementNotAvailableException)
      {
        return null;
      }
    }
    return null;
  }

  /// <summary>Map a pixel delta to UIA scroll increments: a page for a big delta, line steps for a small one.</summary>
  private static (ScrollAmount Amount, int Steps) Amount(int delta, int viewSize, bool vertical)
  {
    if (delta == 0) return (ScrollAmount.NoAmount, 0);
    var forward = delta > 0; // positive = down / right
    var pages = Math.Abs(delta) / (double)viewSize;
    if (pages >= 0.75)
    {
      var amount = forward ? ScrollAmount.LargeIncrement : ScrollAmount.LargeDecrement;
      return (amount, Math.Clamp((int)Math.Round(pages), 1, 20));
    }
    var small = forward ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement;
    return (small, Math.Clamp((int)Math.Round(Math.Abs(delta) / 40.0), 1, 40));
  }

  /* Window helpers ----------------------------------------------------------------- */

  /// <summary>The deepest child window at a point (or the element's own window) when it is one of the given classic classes.</summary>
  private static IntPtr FindWindowForPoint(IntPtr topWindow, AutomationElement? element, POINT screenPoint, HashSet<string> classes)
  {
    foreach (var candidate in CandidateWindows(topWindow, element, screenPoint))
    {
      if (classes.Contains(Native.ControlClassOf(candidate))) return candidate;
    }
    return IntPtr.Zero;
  }

  private static IntPtr FindTextWindow(IntPtr topWindow, AutomationElement? element)
  {
    if (element is not null)
    {
      var owner = NearestWindow(element);
      return owner != IntPtr.Zero && TextClasses.Contains(Native.ControlClassOf(owner)) ? owner : IntPtr.Zero;
    }

    // No target element: type into whatever has keyboard focus in that app, if it is a classic text control.
    var thread = Native.GetWindowThreadProcessId(topWindow, out _);
    var info = new GUITHREADINFO { cbSize = System.Runtime.InteropServices.Marshal.SizeOf<GUITHREADINFO>() };
    if (!Native.GetGUIThreadInfo(thread, ref info) || info.hwndFocus == IntPtr.Zero) return IntPtr.Zero;
    return TextClasses.Contains(Native.ControlClassOf(info.hwndFocus)) ? info.hwndFocus : IntPtr.Zero;
  }

  private static IEnumerable<IntPtr> CandidateWindows(IntPtr topWindow, AutomationElement? element, POINT screenPoint)
  {
    // The window that actually receives clicks at this spot is the deepest child there; an element's own window
    // is the same thing when the element is a whole control. Never skip past a non-classic window to a classic
    // ancestor, because the click would then go to the ancestor instead of the control on top of it.
    var owner = element is null ? IntPtr.Zero : NearestWindow(element);
    if (owner != IntPtr.Zero) yield return owner;
    else
    {
      var deepest = DeepestChildAt(topWindow, screenPoint);
      if (deepest != IntPtr.Zero) yield return deepest;
    }
  }

  /// <summary>The element's own window handle, or the closest ancestor's (a toolbar button has none; its toolbar does).</summary>
  private static IntPtr NearestWindow(AutomationElement element)
  {
    var current = element;
    for (var hop = 0; hop < 6 && current is not null; hop++)
    {
      try
      {
        var handle = new IntPtr(current.Current.NativeWindowHandle);
        if (handle != IntPtr.Zero) return handle;
        current = TreeWalker.ControlViewWalker.GetParent(current);
      }
      catch (ElementNotAvailableException)
      {
        return IntPtr.Zero;
      }
    }
    return IntPtr.Zero;
  }

  private static IntPtr DeepestChildAt(IntPtr topWindow, POINT screenPoint)
  {
    var current = topWindow;
    for (var depth = 0; depth < 8; depth++)
    {
      var client = screenPoint;
      Native.ScreenToClient(current, ref client);
      var child = Native.ChildWindowFromPointEx(current, client, Native.CWP_SKIPINVISIBLE | Native.CWP_SKIPDISABLED);
      if (child == IntPtr.Zero || child == current) break;
      current = child;
    }
    return current == topWindow ? IntPtr.Zero : current;
  }

  private static bool IsInteractive(string role) =>
    role is "Button" or "CheckBox" or "ComboBox" or "Hyperlink" or "ListItem" or "MenuItem" or "RadioButton" or "SplitButton" or "TabItem" or "TreeItem" or "DataItem";

  private static string SafeRole(AutomationElement el)
  {
    try
    {
      return el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
    }
    catch (ElementNotAvailableException)
    {
      return "";
    }
  }

  private static int SafeProcessId(AutomationElement el)
  {
    try
    {
      return el.Current.ProcessId;
    }
    catch (ElementNotAvailableException)
    {
      return -1;
    }
  }

  /// <summary>
  /// Run a UI Automation action and, if the app grabs the foreground in response (classic Win32 providers do, a few
  /// milliseconds after the call returns), put the previous window back. The outcome says so, because a window did
  /// flash forward even though the user's focus is restored.
  /// </summary>
  private static ActionOutcome? Guarded(IntPtr target, Func<ActionOutcome?> attempt)
  {
    var before = Native.GetForegroundWindow();
    var watch = before != IntPtr.Zero && !Foreground.Has(target);
    var outcome = attempt();
    if (outcome is null || !watch) return outcome;

    var pid = Native.ProcessIdOf(target);
    var beforeRoot = Native.RootOf(before);
    var deadline = Environment.TickCount64 + ForegroundWatchMs;
    while (true)
    {
      var now = Native.GetForegroundWindow();
      if (now != IntPtr.Zero && Native.RootOf(now) != beforeRoot && Native.ProcessIdOf(now) == pid)
      {
        if (Native.IsWindow(before)) Foreground.Activate(before, 400);
        return outcome with
        {
          FocusChanged = true,
          Detail = $"{outcome.Detail} (the app took focus; the previous window was restored)",
        };
      }
      if (Environment.TickCount64 >= deadline) return outcome;
      Thread.Sleep(10);
    }
  }

  /// <summary>
  /// Run a UIA call with a time limit. Invoke() on a button that opens a modal dialog can block until the dialog
  /// closes, which would freeze the whole host; on timeout the call keeps running on its own thread and we move on.
  /// </summary>
  private static bool RunBounded(Action action, int timeoutMs)
  {
    Exception? error = null;
    var task = Task.Run(() =>
    {
      try
      {
        action();
      }
      catch (Exception ex)
      {
        error = ex;
      }
    });
    if (!task.Wait(timeoutMs)) return false;
    if (error is not null) ExceptionDispatchInfo.Capture(error).Throw();
    return true;
  }
}
