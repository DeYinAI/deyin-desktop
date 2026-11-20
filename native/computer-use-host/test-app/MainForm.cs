using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DeyinTestApp;

internal sealed class MainForm : Form
{
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

  private readonly string? _logPath;
  private readonly string? _cmdPath;
  private readonly object _logLock = new();
  private readonly Label _status = new() { Text = "ready", AutoSize = true, Name = "lblStatus", AccessibleName = "Status" };
  private readonly ListBox _list = new() { Name = "lstItems", AccessibleName = "Items" };
  private int _clicks;
  private int _lastTop = -1;
  private Point? _dragFrom;
  private Point _dragLast;

  public MainForm(string title, string? logPath, string? pos, string? size, string? cmdPath)
  {
    _logPath = logPath;
    _cmdPath = cmdPath;
    Text = title;
    StartPosition = FormStartPosition.Manual;
    var at = pos?.Split(',') is { Length: 2 } p ? new Point(int.Parse(p[0]), int.Parse(p[1])) : new Point(80, 80);
    Location = at;
    AutoScaleMode = AutoScaleMode.Dpi;
    AutoScaleDimensions = new SizeF(96F, 96F);
    ClientSize = size?.Split(',') is { Length: 2 } sz ? new Size(int.Parse(sz[0]), int.Parse(sz[1])) : new Size(600, 420);
    FormBorderStyle = FormBorderStyle.FixedSingle;
    MaximizeBox = false;
    KeyPreview = true;

    var click = new Button { Text = "Click me", Name = "btnClick", Location = new Point(20, 20), Size = new Size(120, 32) };
    click.Click += (_, _) =>
    {
      _clicks++;
      _status.Text = $"clicked {_clicks}";
      Log($"click:btnClick:{_clicks}");
    };

    var check = new CheckBox { Text = "Check me", Name = "chkCheck", Location = new Point(20, 64), AutoSize = true };
    check.CheckedChanged += (_, _) => Log($"toggle:chkCheck:{check.Checked}");

    var radA = new RadioButton { Text = "Option A", Name = "radA", Location = new Point(20, 96), AutoSize = true };
    var radB = new RadioButton { Text = "Option B", Name = "radB", Location = new Point(130, 96), AutoSize = true };
    radA.CheckedChanged += (_, _) => { if (radA.Checked) Log("radio:radA"); };
    radB.CheckedChanged += (_, _) => { if (radB.Checked) Log("radio:radB"); };

    var input = new TextBox { Name = "txtInput", AccessibleName = "Input field", Location = new Point(20, 130), Size = new Size(300, 26) };
    input.TextChanged += (_, _) => Log($"text:txtInput:{Describe(input.Text)}");

    var notes = new TextBox
    {
      Name = "txtNotes",
      AccessibleName = "Notes",
      Multiline = true,
      AcceptsReturn = true,
      Location = new Point(20, 170),
      Size = new Size(300, 80),
    };
    notes.TextChanged += (_, _) => Log($"text:txtNotes:{Describe(notes.Text)}");

    var combo = new ComboBox { Name = "cmbPick", AccessibleName = "Pick", DropDownStyle = ComboBoxStyle.DropDownList, Location = new Point(340, 20), Size = new Size(150, 24) };
    combo.Items.AddRange(new object[] { "Alpha", "Beta", "Gamma" });
    combo.SelectedIndexChanged += (_, _) => Log($"combo:cmbPick:{combo.SelectedItem}");

    _list.Location = new Point(340, 60);
    _list.Size = new Size(200, 150);
    for (var i = 0; i < 120; i++) _list.Items.Add($"Item {i}");
    _list.MouseWheel += (_, e) => Log($"wheel:lstItems:{e.Delta}");

    var dialog = new Button { Text = "Open dialog", Name = "btnDialog", Location = new Point(20, 262), Size = new Size(120, 32) };
    dialog.Click += (_, _) =>
    {
      Log("dialog:open");
      MessageBox.Show(this, "Hello from the test dialog", "Test dialog");
      Log("dialog:closed");
    };

    var surface = new Panel
    {
      Name = "pnlSurface",
      AccessibleName = "Surface",
      AccessibleRole = AccessibleRole.Pane,
      BackColor = Color.LightSteelBlue,
      Location = new Point(160, 262),
      Size = new Size(200, 100),
    };
    surface.MouseEnter += (_, _) => Log("hover:pnlSurface");
    surface.MouseDown += (_, e) =>
    {
      Log($"mousedown:pnlSurface:{e.Button}@{e.X},{e.Y} size={surface.Width}x{surface.Height}");
      if (e.Button == MouseButtons.Left)
      {
        _dragFrom = e.Location;
        _dragLast = e.Location;
      }
    };
    surface.MouseMove += (_, e) =>
    {
      if (_dragFrom is not null) _dragLast = e.Location;
    };
    surface.MouseUp += (_, e) =>
    {
      Log($"mouseup:pnlSurface:{e.Button}@{e.X},{e.Y}");
      if (_dragFrom is { } from && e.Button == MouseButtons.Left && from != e.Location)
      {
        Log($"drag:pnlSurface:{from.X},{from.Y}->{e.X},{e.Y}");
      }
      _dragFrom = null;
    };
    surface.MouseDoubleClick += (_, e) => Log($"dblclick:pnlSurface:{e.Button}");

    _status.Location = new Point(20, 380);

    Controls.AddRange(new Control[] { click, check, radA, radB, input, notes, combo, _list, dialog, surface, _status });

    Activated += (_, _) => Log("activated");
    Deactivate += (_, _) => Log("deactivated");
    KeyDown += (_, e) => Log($"key:{e.KeyData}");
    Shown += (_, _) => Log($"ready hwnd={Handle.ToInt64()}");

    // WinForms has no scroll event for ListBox; watching TopIndex is enough to prove it moved.
    var watcher = new System.Windows.Forms.Timer { Interval = 80 };
    watcher.Tick += (_, _) =>
    {
      RunCommand();
      if (_list.TopIndex == _lastTop) return;
      _lastTop = _list.TopIndex;
      Log($"top:lstItems:{_lastTop}");
    };
    watcher.Start();
  }

  /// <summary>The test asks a window to take the foreground (the way a user would click it) by writing "front" to a file.</summary>
  private void RunCommand()
  {
    if (_cmdPath is null || !File.Exists(_cmdPath)) return;
    string command;
    try
    {
      command = File.ReadAllText(_cmdPath).Trim();
      File.Delete(_cmdPath);
    }
    catch (IOException)
    {
      return; // still being written
    }
    if (command != "front") return;
    var current = GetForegroundWindow();
    var currentThread = current == IntPtr.Zero ? 0 : GetWindowThreadProcessId(current, out _);
    var me = GetCurrentThreadId();
    var attached = currentThread != 0 && currentThread != me && AttachThreadInput(me, currentThread, true);
    try
    {
      SetForegroundWindow(Handle);
    }
    finally
    {
      if (attached) AttachThreadInput(me, currentThread, false);
    }
  }

  /// <summary>Short text is logged whole; long text as its length, so a 60k-character paste does not write gigabytes.</summary>
  private static string Describe(string text) =>
    text.Length <= 200 ? text.Replace("\r", "\\r").Replace("\n", "\\n") : $"len={text.Length}";

  private void Log(string line)
  {
    if (_logPath is null) return;
    lock (_logLock)
    {
      try
      {
        File.AppendAllText(_logPath, $"{Environment.TickCount64}\t{line}\n");
      }
      catch (IOException)
      {
        // the test is reading the file at this instant; the next event will be written
      }
    }
  }
}
