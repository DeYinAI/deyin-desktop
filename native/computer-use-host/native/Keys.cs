namespace Deyin.ComputerUseHost;

/// <summary>A parsed key chord such as <c>ctrl+shift+t</c>: modifiers held while one key is tapped.</summary>
internal sealed record KeyChord(IReadOnlyList<ushort> Modifiers, ushort Vk, string Display)
{
  /// <summary>True for a plain key with no modifiers (Enter, Tab, an arrow): eligible for posted messages.</summary>
  public bool IsSimple => Modifiers.Count == 0;
}

internal static class Keys
{
  public const ushort VK_SHIFT = 0x10;
  public const ushort VK_CONTROL = 0x11;
  public const ushort VK_MENU = 0x12; // Alt
  public const ushort VK_LWIN = 0x5B;
  public const ushort VK_RETURN = 0x0D;
  public const ushort VK_TAB = 0x09;

  private static readonly Dictionary<string, ushort> Modifiers = new(StringComparer.OrdinalIgnoreCase)
  {
    ["ctrl"] = VK_CONTROL, ["control"] = VK_CONTROL,
    ["shift"] = VK_SHIFT,
    ["alt"] = VK_MENU, ["option"] = VK_MENU,
    ["win"] = VK_LWIN, ["windows"] = VK_LWIN, ["meta"] = VK_LWIN, ["super"] = VK_LWIN, ["cmd"] = VK_LWIN, ["command"] = VK_LWIN,
  };

  private static readonly Dictionary<string, ushort> Named = BuildNamed();

  private static readonly HashSet<ushort> Extended = new()
  {
    0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, // PageUp PageDown End Home arrows
    0x2C, 0x2D, 0x2E, // PrintScreen Insert Delete
    0x5B, 0x5C, 0x5D, // Win keys, Apps
    0x6F, 0x90, // numpad divide, NumLock
  };

  private static Dictionary<string, ushort> BuildNamed()
  {
    var map = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
    {
      ["enter"] = 0x0D, ["return"] = 0x0D,
      ["tab"] = 0x09,
      ["escape"] = 0x1B, ["esc"] = 0x1B,
      ["backspace"] = 0x08,
      ["space"] = 0x20, ["spacebar"] = 0x20,
      ["delete"] = 0x2E, ["del"] = 0x2E,
      ["insert"] = 0x2D, ["ins"] = 0x2D,
      ["home"] = 0x24, ["end"] = 0x23,
      ["pageup"] = 0x21, ["pgup"] = 0x21, ["prior"] = 0x21,
      ["pagedown"] = 0x22, ["pgdn"] = 0x22, ["next"] = 0x22,
      ["up"] = 0x26, ["arrowup"] = 0x26,
      ["down"] = 0x28, ["arrowdown"] = 0x28,
      ["left"] = 0x25, ["arrowleft"] = 0x25,
      ["right"] = 0x27, ["arrowright"] = 0x27,
      ["capslock"] = 0x14, ["numlock"] = 0x90, ["scrolllock"] = 0x91,
      ["printscreen"] = 0x2C, ["pause"] = 0x13, ["apps"] = 0x5D,
      ["multiply"] = 0x6A, ["add"] = 0x6B, ["subtract"] = 0x6D, ["decimal"] = 0x6E, ["divide"] = 0x6F,
      ["plus"] = 0xBB, ["equal"] = 0xBB, ["equals"] = 0xBB,
      ["minus"] = 0xBD, ["hyphen"] = 0xBD,
      ["comma"] = 0xBC, ["period"] = 0xBE, ["dot"] = 0xBE,
      ["slash"] = 0xBF, ["backslash"] = 0xDC,
      ["semicolon"] = 0xBA, ["quote"] = 0xDE, ["apostrophe"] = 0xDE,
      ["backtick"] = 0xC0, ["grave"] = 0xC0,
      ["bracketleft"] = 0xDB, ["bracketright"] = 0xDD,
    };
    for (var i = 1; i <= 24; i++) map[$"f{i}"] = (ushort)(0x6F + i);
    for (var i = 0; i <= 9; i++) map[$"numpad{i}"] = (ushort)(0x60 + i);
    return map;
  }

  public static bool IsExtended(ushort vk) => Extended.Contains(vk);

  public static bool IsModifier(ushort vk) => vk is VK_SHIFT or VK_CONTROL or VK_MENU or VK_LWIN;

  /// <summary>Modifier names a click can hold ("ctrl", "shift", "alt", "win").</summary>
  public static IReadOnlyList<ushort> ParseModifiers(IEnumerable<string> names)
  {
    var list = new List<ushort>();
    foreach (var raw in names)
    {
      var name = raw.Trim();
      if (name.Length == 0) continue;
      if (!Modifiers.TryGetValue(name, out var mod))
      {
        throw new InvalidOperationException($"Unknown modifier \"{name}\". Use ctrl, shift, alt or win.");
      }
      if (!list.Contains(mod)) list.Add(mod);
    }
    return list;
  }

  /// <summary>Parse "Enter", "ctrl+a", "Ctrl+Shift+T", "alt+f4", "win+r". Throws a message the model can act on.</summary>
  public static KeyChord ParseChord(string spec)
  {
    if (string.IsNullOrWhiteSpace(spec)) throw new InvalidOperationException("key is required (for example Enter, Escape, ctrl+a or ctrl+shift+t).");
    var trimmed = spec.Trim();
    // A trailing "+" is the plus key itself ("ctrl++"); spell it out so splitting stays simple.
    if (trimmed.EndsWith("++", StringComparison.Ordinal)) trimmed = trimmed[..^1] + "plus";
    else if (trimmed == "+") trimmed = "plus";

    var parts = trimmed.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
    if (parts.Length == 0) throw new InvalidOperationException($"Empty key: \"{spec}\".");

    var mods = new List<ushort>();
    for (var i = 0; i < parts.Length - 1; i++)
    {
      if (!Modifiers.TryGetValue(parts[i], out var mod))
      {
        throw new InvalidOperationException($"Unknown modifier \"{parts[i]}\" in \"{spec}\". Use ctrl, shift, alt or win.");
      }
      if (!mods.Contains(mod)) mods.Add(mod);
    }

    var key = parts[^1];
    // A bare modifier ("shift") is a valid single key press.
    if (parts.Length == 1 && Modifiers.TryGetValue(key, out var onlyMod)) return new KeyChord(Array.Empty<ushort>(), onlyMod, spec);
    return new KeyChord(mods, ResolveKey(key, spec), spec);
  }

  private static ushort ResolveKey(string key, string spec)
  {
    if (Named.TryGetValue(key, out var named)) return named;
    if (key.Length == 1)
    {
      var ch = key[0];
      if (ch is >= 'a' and <= 'z') return (ushort)char.ToUpperInvariant(ch);
      if (ch is >= 'A' and <= 'Z') return ch;
      if (ch is >= '0' and <= '9') return ch;
      var scan = Native.VkKeyScan(ch);
      if (scan != -1) return (ushort)(scan & 0xFF);
    }
    throw new InvalidOperationException($"Unknown key \"{key}\" in \"{spec}\". Use a name like Enter, Escape, Tab, F5, PageDown, ArrowLeft, or a single letter or digit.");
  }
}
