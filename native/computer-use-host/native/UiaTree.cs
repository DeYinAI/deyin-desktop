using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace Deyin.ComputerUseHost;

public sealed class UiaTree
{
  private readonly Dictionary<string, AutomationElement> _refs = new();

  public object[] BuildTree(IntPtr hwnd)
  {
    _refs.Clear();
    var root = AutomationElement.FromHandle(hwnd);
    if (root is null) return Array.Empty<object>();
    var nodes = new List<object>();
    Walk(root, nodes, 0, 120);
    return nodes.ToArray();
  }

  private void Walk(AutomationElement el, List<object> nodes, int depth, int budget)
  {
    if (budget <= 0 || depth > 12) return;
    var rect = el.Current.BoundingRectangle;
    if (rect.Width <= 0 || rect.Height <= 0) return;
    var refId = $"e{nodes.Count + 1}";
    _refs[refId] = el;
    nodes.Add(new
    {
      @ref = refId,
      role = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
      name = el.Current.Name ?? "",
      bounds = new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height },
    });
    if (depth >= 12) return;
    foreach (AutomationElement child in el.FindAll(TreeScope.Children, Condition.TrueCondition))
    {
      Walk(child, nodes, depth + 1, budget - 1);
      if (nodes.Count >= budget) return;
    }
  }

  public (int X, int Y) ResolveRef(IntPtr hwnd, string refId)
  {
    if (_refs.TryGetValue(refId, out var el))
    {
      var rect = el.Current.BoundingRectangle;
      return ((int)(rect.X + rect.Width / 2), (int)(rect.Y + rect.Height / 2));
    }
    throw new InvalidOperationException($"Unknown ref {refId}. Call get_window_state first.");
  }

  public void SetValue(IntPtr hwnd, string refId, string value)
  {
    if (!_refs.TryGetValue(refId, out var el))
    {
      BuildTree(hwnd);
      if (!_refs.TryGetValue(refId, out el)) throw new InvalidOperationException($"Unknown ref {refId}.");
    }
    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern) && pattern is ValuePattern valuePattern)
    {
      valuePattern.SetValue(value);
      return;
    }
    throw new InvalidOperationException($"Element {refId} does not support ValuePattern.");
  }
}
