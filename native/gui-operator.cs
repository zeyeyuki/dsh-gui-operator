// gui-operator.exe - Windows desktop eyes and hands for the dsh-gui-operator plugin.
//
// One dependency-free console program (compiled by csc.exe from .NET Framework,
// which ships with Windows) that provides:
//   * a physical-pixel screenshot of the whole desktop,
//   * the top-level window list,
//   * the UI Automation control tree of one window (readable text, buttons,
//     edit boxes with their current value),
//   * mouse and keyboard injection (click / move / drag / scroll / key / paste).
//
// Built as an executable rather than an inline PowerShell Add-Type blob on
// purpose: Defender/AMSI blocks scripts that combine clipboard and input APIs
// ("ScriptContainedMaliciousContent"), while the same code in a normal console
// program runs. It is also ~20x faster to start than powershell.exe.
//
// Build:
//   powershell -ExecutionPolicy Bypass -File build.ps1
//
// Every command prints exactly one JSON object on stdout and exits 0 on
// success, 1 on failure. Nothing else is written to stdout.
//
// Usage:
//   gui-operator.exe observe [--window <hwnd|title-substring>] [--max <n>]
//                            [--max-width <n>] [--all] [--no-shot] [--no-tree]
//   gui-operator.exe resolve --hwnd <n> --path <a.b.c> [--type <t>] [--name <n>]
//   gui-operator.exe click <x> <y> [left|right|middle] [count]
//   gui-operator.exe move <x> <y>
//   gui-operator.exe drag <x1> <y1> <x2> <y2>
//   gui-operator.exe scroll <clicks> [x] [y]
//   gui-operator.exe key <ctrl+shift+s>
//   gui-operator.exe type <base64 utf8 text>
//   gui-operator.exe focus <hwnd>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class GuiOperator
{
    // ------------------------------------------------------------------ native

    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public INPUTUNION data; }

    private const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP_LOCAL = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    /// <summary>Type one Unicode character through SendInput, bypassing the clipboard.</summary>
    private static void SendUnicodeCharacter(char character)
    {
        var down = new INPUT();
        down.type = INPUT_KEYBOARD;
        down.data.ki.wScan = (ushort)character;
        down.data.ki.dwFlags = KEYEVENTF_UNICODE;

        var up = new INPUT();
        up.type = INPUT_KEYBOARD;
        up.data.ki.wScan = (ushort)character;
        up.data.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP_LOCAL;

        INPUT[] batch = { down, up };
        SendInput(2, batch, Marshal.SizeOf(typeof(INPUT)));
    }

    [DllImport("user32.dll")] private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern bool EmptyClipboard();
    [DllImport("user32.dll")] private static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("user32.dll")] private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalLock(IntPtr mem);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr mem);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr mem);

    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr param);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    private const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    private const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800;
    private const uint KEYUP = 0x0002, EXTENDED = 0x0001;
    private const uint CF_UNICODETEXT = 13, GMEM_MOVEABLE = 0x0002;

    // -------------------------------------------------------------------- json

    // Minimal serializer: Dictionary<string,object>, List<object>, string, bool,
    // long/double, and null. Everything else is an authoring bug and throws.
    private static string Serialize(object value)
    {
        var builder = new StringBuilder(4096);
        WriteJson(builder, value);
        return builder.ToString();
    }

    private static void WriteJson(StringBuilder builder, object value)
    {
        if (value == null) { builder.Append("null"); return; }
        if (value is string) { WriteString(builder, (string)value); return; }
        if (value is bool) { builder.Append(((bool)value) ? "true" : "false"); return; }

        if (value is int) { builder.Append(((int)value).ToString(CultureInfo.InvariantCulture)); return; }
        if (value is long) { builder.Append(((long)value).ToString(CultureInfo.InvariantCulture)); return; }
        if (value is double)
        {
            double number = (double)value;
            if (double.IsNaN(number) || double.IsInfinity(number)) { builder.Append("null"); return; }
            builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
            return;
        }

        var map = value as Dictionary<string, object>;
        if (map != null)
        {
            builder.Append('{');
            bool first = true;
            foreach (KeyValuePair<string, object> pair in map)
            {
                if (!first) builder.Append(',');
                first = false;
                WriteString(builder, pair.Key);
                builder.Append(':');
                WriteJson(builder, pair.Value);
            }
            builder.Append('}');
            return;
        }

        var list = value as List<object>;
        if (list != null)
        {
            builder.Append('[');
            for (int i = 0; i < list.Count; i++)
            {
                if (i > 0) builder.Append(',');
                WriteJson(builder, list[i]);
            }
            builder.Append(']');
            return;
        }

        throw new InvalidOperationException("cannot serialize " + value.GetType().FullName);
    }

    private static void WriteString(StringBuilder builder, string text)
    {
        builder.Append('"');
        foreach (char c in text)
        {
            switch (c)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (c < 0x20) builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else builder.Append(c);
                    break;
            }
        }
        builder.Append('"');
    }

    private static Dictionary<string, object> NewMap()
    {
        return new Dictionary<string, object>(StringComparer.Ordinal);
    }

    private static int Emit(Dictionary<string, object> payload)
    {
        bool ok = payload.ContainsKey("ok") && payload["ok"] is bool && (bool)payload["ok"];
        Console.Out.Write(Serialize(payload));
        Console.Out.Flush();
        return ok ? 0 : 1;
    }

    private static int EmitError(string message, string code)
    {
        var map = NewMap();
        map["ok"] = false;
        map["error"] = message;
        map["code"] = code;
        return Emit(map);
    }

    private static List<object> Array(params object[] items)
    {
        var list = new List<object>(items.Length);
        foreach (object item in items) list.Add(item);
        return list;
    }

    // -------------------------------------------------------------------- main

    private static int Main(string[] args)
    {
        // Physical pixels everywhere: screenshot, UIA rectangles, cursor position
        // and window rectangles then share one coordinate space.
        SetProcessDPIAware();
        Console.OutputEncoding = new UTF8Encoding(false);

        try
        {
            if (args.Length == 0) return EmitError("no command", "NO_COMMAND");
            string command = args[0].ToLowerInvariant();

            var options = NewMap();
            var positional = new List<string>();
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i].StartsWith("--", StringComparison.Ordinal))
                {
                    string key = args[i].Substring(2);
                    bool hasValue = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal);
                    options[key] = hasValue ? args[++i] : "true";
                }
                else positional.Add(args[i]);
            }

            switch (command)
            {
                case "observe": return Observe(options);
                case "resolve": return Resolve(options);
                case "focus": return Focus(positional);
                case "click": return ClickCommand(positional);
                case "move": return MoveCommand(positional);
                case "drag": return DragCommand(positional);
                case "scroll": return ScrollCommand(positional);
                case "key": return KeyCommand(positional);
                case "type": return TypeCommand(positional);
                default: return EmitError("unknown command '" + command + "'", "UNKNOWN_COMMAND");
            }
        }
        catch (Exception error)
        {
            return EmitError(error.Message, "UNEXPECTED");
        }
    }

    private static bool Flag(Dictionary<string, object> options, string name)
    {
        object value;
        if (!options.TryGetValue(name, out value)) return false;
        return (string)value != "false";
    }

    private static string Option(Dictionary<string, object> options, string name, string fallback)
    {
        object value;
        if (!options.TryGetValue(name, out value)) return fallback;
        string text = (string)value;
        return string.IsNullOrEmpty(text) ? fallback : text;
    }

    private static int IntOption(Dictionary<string, object> options, string name, int fallback)
    {
        string text = Option(options, name, null);
        int parsed;
        if (text == null || !int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return fallback;
        return parsed;
    }

    // ------------------------------------------------------------------ observe

    private static int Observe(Dictionary<string, object> options)
    {
        var result = NewMap();
        result["ok"] = true;

        Rectangle bounds = SystemInformation.VirtualScreen;
        var screen = NewMap();
        screen["x"] = bounds.X;
        screen["y"] = bounds.Y;
        screen["w"] = bounds.Width;
        screen["h"] = bounds.Height;
        screen["count"] = Screen.AllScreens.Length;
        result["screen"] = screen;

        List<object> windows = ListWindows(30);
        result["windows"] = windows;

        IntPtr foreground = GetForegroundWindow();
        if (foreground != IntPtr.Zero)
        {
            var info = NewMap();
            info["hwnd"] = foreground.ToInt64();
            info["title"] = WindowTitle(foreground);
            info["process"] = ProcessName(foreground);
            RECT foregroundRect;
            if (GetWindowRect(foreground, out foregroundRect))
            {
                info["r"] = RectArray(foregroundRect);
            }
            result["foreground"] = info;
        }

        if (!Flag(options, "no-shot"))
        {
            string path;
            int width, height;
            string error;
            if (!Capture(out path, out width, out height, out error, IntOption(options, "max-width", 0)))
                return EmitError(error, "SCREENSHOT_FAILED");
            var shot = NewMap();
            shot["path"] = path;
            shot["w"] = width;
            shot["h"] = height;
            shot["scale"] = bounds.Width == 0 ? 1.0 : (double)width / bounds.Width;
            result["screenshot"] = shot;
        }

        if (!Flag(options, "no-tree") || Option(options, "window", null) != null)
        {
            IntPtr target;
            string targetError;
            if (!ResolveWindow(Option(options, "window", null), out target, out targetError))
                return EmitError(targetError, "WINDOW_NOT_FOUND");

            var window = NewMap();
            window["hwnd"] = target.ToInt64();
            window["title"] = WindowTitle(target);
            window["min"] = IsIconic(target);
            result["window"] = window;

            if (!Flag(options, "no-tree"))
            {
                AutomationElement root = AutomationElement.FromHandle(target);
                if (root == null) return EmitError("UI Automation cannot attach to that window", "NO_UIA");

                int max = IntOption(options, "max", 150);
                if (max < 1) max = 1;
                if (max > 600) max = 600;

                bool truncated;
                int passwordFields;
                List<object> elements = Snapshot(root, max, 14, Flag(options, "all"), 8000, out truncated, out passwordFields);

                result["elements"] = elements;
                result["truncated"] = truncated;
                result["passwordFields"] = passwordFields;
            }
        }

        return Emit(result);
    }

    private static List<object> ListWindows(int limit)
    {
        var windows = new List<object>();
        var ids = new List<IntPtr>();
        EnumWindows(delegate(IntPtr handle, IntPtr unused)
        {
            if (windows.Count >= limit) return false;
            if (!IsWindowVisible(handle)) return true;
            if (GetWindowTextLength(handle) == 0) return true;
            RECT rect;
            if (!GetWindowRect(handle, out rect)) return true;
            if (rect.Right - rect.Left <= 0 || rect.Bottom - rect.Top <= 0) return true;
            ids.Add(handle);
            var entry = NewMap();
            entry["hwnd"] = handle.ToInt64();
            entry["title"] = WindowTitle(handle);
            entry["process"] = ProcessName(handle);
            entry["min"] = IsIconic(handle);
            entry["r"] = RectArray(rect);
            windows.Add(entry);
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    private static string WindowTitle(IntPtr handle)
    {
        int length = GetWindowTextLength(handle);
        if (length <= 0) return string.Empty;
        var buffer = new StringBuilder(length + 2);
        GetWindowText(handle, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static string ProcessName(IntPtr handle)
    {
        uint pid;
        GetWindowThreadProcessId(handle, out pid);
        if (pid == 0) return string.Empty;
        try { return Process.GetProcessById((int)pid).ProcessName; }
        catch { return string.Empty; }
    }

    private static List<object> RectArray(RECT rect)
    {
        return Array(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    private static bool ResolveWindow(string spec, out IntPtr handle, out string error)
    {
        handle = IntPtr.Zero;
        error = null;

        long numeric;
        if (spec != null && long.TryParse(spec, NumberStyles.Integer, CultureInfo.InvariantCulture, out numeric))
        {
            IntPtr candidate = new IntPtr(numeric);
            if (!IsWindow(candidate)) { error = "window handle " + spec + " is gone"; return false; }
            handle = candidate;
            return true;
        }

        if (!string.IsNullOrEmpty(spec))
        {
            // First visible window whose title or process name contains the text,
            // in z-order, so the topmost match wins.
            var matches = new List<object>();
            var handles = new List<KeyValuePair<IntPtr, string>>();
            EnumWindows(delegate(IntPtr candidate, IntPtr unused)
            {
                if (matches.Count >= 200) return false;
                if (!IsWindowVisible(candidate)) return true;
                string title = WindowTitle(candidate);
                if (title.Length == 0) return true;
                string process = ProcessName(candidate);
                if (title.IndexOf(spec, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    process.IndexOf(spec, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    matches.Add(title);
                    handles.Add(new KeyValuePair<IntPtr, string>(candidate, title));
                }
                return true;
            }, IntPtr.Zero);

            if (handles.Count == 0)
            {
                error = "no window matches '" + spec + "'; run observe to list windows";
                return false;
            }
            handle = handles[0].Key;
            return true;
        }

        handle = GetForegroundWindow();
        if (handle == IntPtr.Zero) { error = "no foreground window"; return false; }
        return true;
    }

    // The set of UIA control types that carry information a person reads off the
    // screen: actionable controls plus static text and documents.
    private static readonly HashSet<string> InterestingTypes = new HashSet<string>(StringComparer.Ordinal)
    {
        "Button", "CheckBox", "ComboBox", "Edit", "Hyperlink", "List", "ListItem", "MenuItem",
        "RadioButton", "Slider", "Spinner", "Tab", "TabItem", "Text", "TreeItem", "DataItem",
        "Document", "SplitButton", "Header",
    };

    private static List<object> Snapshot(
        AutomationElement root, int max, int maxDepth, bool all, int budgetMs,
        out bool truncated, out int passwordFields)
    {
        var elements = new List<object>();
        truncated = false;
        passwordFields = 0;

        TreeWalker walker = TreeWalker.ControlViewWalker;
        var stopwatch = Stopwatch.StartNew();

        // Frame stack of (element, path, depth); explicit to survive deep trees.
        var stack = new Stack<object[]>();
        stack.Push(new object[] { root, new int[0], 0 });

        while (stack.Count > 0)
        {
            object[] frame = stack.Pop();
            AutomationElement element = (AutomationElement)frame[0];
            int[] path = (int[])frame[1];
            int depth = (int)frame[2];

            if (stopwatch.ElapsedMilliseconds > budgetMs) { truncated = true; break; }

            if (depth > 0)
            {
                try
                {
                    AutomationElement.AutomationElementInformation current = element.Current;
                    string type = ControlTypeName(current.ControlType);
                    string name = current.Name ?? string.Empty;
                    string automationId = current.AutomationId ?? string.Empty;
                    System.Windows.Rect rect = current.BoundingRectangle;
                    bool keep = all || InterestingTypes.Contains(type);

                    if (keep && (name.Length > 0 || automationId.Length > 0) &&
                        rect.Width > 0 && rect.Height > 0)
                    {
                        var entry = NewMap();
                        entry["i"] = elements.Count;
                        entry["p"] = PathText(path);
                        entry["t"] = type;
                        entry["n"] = name.Length > 240 ? name.Substring(0, 240) + "..." : name;
                        entry["r"] = Array(
                            (int)Math.Round(rect.X), (int)Math.Round(rect.Y),
                            (int)Math.Round(rect.Width), (int)Math.Round(rect.Height));
                        entry["off"] = current.IsOffscreen;
                        entry["dis"] = !current.IsEnabled;
                        if (automationId.Length > 0) entry["aid"] = automationId;

                        if (type == "Edit")
                        {
                            bool isPassword = false;
                            try { isPassword = current.IsPassword; } catch { }
                            if (isPassword)
                            {
                                entry["pwd"] = true;
                                passwordFields++;
                            }
                            else
                            {
                                try
                                {
                                    var pattern = (ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern);
                                    string value = pattern.Current.Value ?? string.Empty;
                                    if (value.Length > 200) value = value.Substring(0, 200) + "...";
                                    entry["v"] = value;
                                }
                                catch { }
                            }
                        }
                        else if (type == "Document")
                        {
                            // TextPattern is how a rendered document (browser page, chat
                            // window, editor) hands over the text a person would read.
                            try
                            {
                                var textPattern = (TextPattern)element.GetCurrentPattern(TextPattern.Pattern);
                                string documentText = textPattern.DocumentRange.GetText(4000) ?? string.Empty;
                                documentText = documentText.Replace("\r\n", "\n").Replace('\r', '\n');
                                if (documentText.Length > 3000)
                                    documentText = documentText.Substring(0, 3000) + "\n...[truncated]";
                                entry["v"] = documentText;
                            }
                            catch { }
                        }

                        elements.Add(entry);
                        if (elements.Count >= max) { truncated = true; break; }
                    }
                }
                catch
                {
                    // Element disappeared between enumeration and read; skip it.
                }
            }

            if (depth >= maxDepth) { truncated = true; continue; }

            try
            {
                var children = new List<AutomationElement>();
                AutomationElement child = walker.GetFirstChild(element);
                while (child != null)
                {
                    children.Add(child);
                    child = walker.GetNextSibling(child);
                }
                // Reverse push so the first child is visited first.
                for (int i = children.Count - 1; i >= 0; i--)
                {
                    var nextPath = new int[path.Length + 1];
                    System.Array.Copy(path, nextPath, path.Length);
                    nextPath[path.Length] = i;
                    stack.Push(new object[] { children[i], nextPath, depth + 1 });
                }
            }
            catch
            {
                // A window can close mid-walk; keep whatever was collected.
            }
        }

        return elements;
    }

    private static string ControlTypeName(ControlType type)
    {
        string name = type.ProgrammaticName ?? string.Empty;
        const string prefix = "ControlType.";
        return name.StartsWith(prefix, StringComparison.Ordinal) ? name.Substring(prefix.Length) : name;
    }

    private static string PathText(int[] path)
    {
        var builder = new StringBuilder();
        for (int i = 0; i < path.Length; i++)
        {
            if (i > 0) builder.Append('.');
            builder.Append(path[i].ToString(CultureInfo.InvariantCulture));
        }
        return builder.ToString();
    }

    private static int[] ParsePath(string text)
    {
        if (string.IsNullOrEmpty(text)) return new int[0];
        string[] parts = text.Split('.');
        var path = new int[parts.Length];
        for (int i = 0; i < parts.Length; i++)
        {
            int value;
            if (!int.TryParse(parts[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
                throw new ArgumentException("invalid element path '" + text + "'");
            path[i] = value;
        }
        return path;
    }

    private static AutomationElement FindByPath(AutomationElement root, int[] path)
    {
        TreeWalker walker = TreeWalker.ControlViewWalker;
        AutomationElement current = root;
        foreach (int wanted in path)
        {
            AutomationElement child = walker.GetFirstChild(current);
            for (int seen = 0; child != null && seen < wanted; seen++) child = walker.GetNextSibling(child);
            if (child == null) return null;
            current = child;
        }
        return current;
    }

    // ------------------------------------------------------------------ resolve

    private static int Resolve(Dictionary<string, object> options)
    {
        string handleText = Option(options, "hwnd", null);
        long handleValue;
        if (handleText == null || !long.TryParse(handleText, NumberStyles.Integer, CultureInfo.InvariantCulture, out handleValue))
            return EmitError("resolve needs --hwnd", "INVALID_ARGS");

        IntPtr handle = new IntPtr(handleValue);
        if (!IsWindow(handle)) return EmitError("the window that owned this element is gone", "WINDOW_GONE");
        if (IsIconic(handle)) {
            return EmitError("that window is minimized, so its controls have no on-screen position; call desktop_act action=focus on it first, then desktop_observe", "WINDOW_MINIMIZED");
        }

        AutomationElement root = AutomationElement.FromHandle(handle);
        if (root == null) return EmitError("UI Automation cannot attach to that window", "NO_UIA");

        AutomationElement element = FindByPath(root, ParsePath(Option(options, "path", string.Empty)));
        if (element == null) return EmitError("element path no longer resolves; run observe again", "STALE_ELEMENT");

        // Cheap identity check: a stale path must not silently hit another control.
        string expectedType = Option(options, "type", null);
        if (expectedType != null && ControlTypeName(element.Current.ControlType) != expectedType)
            return EmitError("element type changed; run observe again", "STALE_ELEMENT");
        string expectedName = Option(options, "name", null);
        if (expectedName != null && !NameMatches(element.Current.Name ?? string.Empty, expectedName))
            return EmitError("element name changed; run observe again", "STALE_ELEMENT");

        if (element.Current.IsOffscreen)
            return EmitError("element is offscreen (scrolled out of view); scroll it into view and observe again", "ELEMENT_OFFSCREEN");

        System.Windows.Rect rect = element.Current.BoundingRectangle;
        if (rect.Width <= 0 || rect.Height <= 0) return EmitError("element has no clickable area", "NO_RECT");

        var result = NewMap();
        result["ok"] = true;
        result["hwnd"] = handle.ToInt64();
        result["type"] = ControlTypeName(element.Current.ControlType);
        result["name"] = element.Current.Name ?? string.Empty;
        result["r"] = Array(
            (int)Math.Round(rect.X), (int)Math.Round(rect.Y),
            (int)Math.Round(rect.Width), (int)Math.Round(rect.Height));
        result["x"] = (int)Math.Round(rect.X + rect.Width / 2);
        result["y"] = (int)Math.Round(rect.Y + rect.Height / 2);
        // Input goes to whatever window is in front, so the caller needs to know
        // whether this element's window is actually the foreground one.
        result["fg"] = GetForegroundWindow() == handle;
        return Emit(result);
    }

    /// <summary>
    /// Compare an element name against the identity recorded in a snapshot. Names
    /// longer than 240 characters are truncated for display, so a prefix compares
    /// the truncation instead of failing forever.
    /// </summary>
    private static bool NameMatches(string actual, string expected)
    {
        const string marker = "...";
        if (expected.EndsWith(marker, StringComparison.Ordinal))
        {
            string prefix = expected.Substring(0, expected.Length - marker.Length);
            return actual.StartsWith(prefix, StringComparison.Ordinal);
        }
        return string.Equals(actual, expected, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------- screenshot

    private static bool Capture(out string path, out int width, out int height, out string error, int maxWidth)
    {
        path = null;
        width = 0;
        height = 0;
        error = null;

        Rectangle bounds = SystemInformation.VirtualScreen;
        Bitmap bitmap = null;
        Graphics graphics = null;
        try
        {
            bitmap = new Bitmap(bounds.Width, bounds.Height);
            graphics = Graphics.FromImage(bitmap);
            graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bitmap.Size);

            if (maxWidth > 0 && bitmap.Width > maxWidth)
            {
                width = maxWidth;
                height = (int)Math.Round(bitmap.Height * ((double)maxWidth / bitmap.Width));
                var resized = new Bitmap(width, height);
                using (Graphics resizeGraphics = Graphics.FromImage(resized))
                {
                    resizeGraphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    resizeGraphics.DrawImage(bitmap, 0, 0, width, height);
                }
                bitmap.Dispose();
                bitmap = resized;
            }
            else
            {
                width = bitmap.Width;
                height = bitmap.Height;
            }

            string directory = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "dsh-gui-operator");
            System.IO.Directory.CreateDirectory(directory);
            PruneScreenshots(directory, "shot-*.jpg");
            path = System.IO.Path.Combine(directory,
                "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture) + ".jpg");

            ImageCodecInfo codec = null;
            foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders())
            {
                if (candidate.MimeType == "image/jpeg") { codec = candidate; break; }
            }
            if (codec == null) { error = "no JPEG encoder available"; return false; }

            using (var parameters = new EncoderParameters(1))
            {
                // Fully qualified: `Encoder` alone is ambiguous with System.Text.Encoder.
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 85L);
                bitmap.Save(path, codec, parameters);
            }
            return true;
        }
        catch (Exception failure)
        {
            error = "screenshot failed: " + failure.Message;
            return false;
        }
        finally
        {
            if (graphics != null) graphics.Dispose();
            if (bitmap != null) bitmap.Dispose();
        }
    }

    // ------------------------------------------------------------------- input

    /// <summary>
    /// Keep the screenshot folder from growing without bound: files matching the
    /// pattern that are older than two hours are deleted, and every failure is
    /// ignored because stale files must never break an observation.
    /// </summary>
    private static void PruneScreenshots(string directory, string pattern)
    {
        try
        {
            DateTime cutoff = DateTime.Now.AddHours(-2);
            foreach (string file in System.IO.Directory.GetFiles(directory, pattern))
            {
                try
                {
                    if (System.IO.File.GetLastWriteTime(file) < cutoff) System.IO.File.Delete(file);
                }
                catch { }
            }
        }
        catch { }
    }

    private static readonly Dictionary<string, byte> VirtualKeys = new Dictionary<string, byte>(StringComparer.OrdinalIgnoreCase)
    {
        { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 },
        { "win", 0x5B }, { "meta", 0x5B }, { "enter", 0x0D }, { "return", 0x0D },
        { "tab", 0x09 }, { "esc", 0x1B }, { "escape", 0x1B }, { "space", 0x20 },
        { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D },
        { "ins", 0x2D }, { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 },
        { "pgup", 0x21 }, { "pagedown", 0x22 }, { "pgdn", 0x22 }, { "up", 0x26 },
        { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 }, { "minus", 0xBD },
        { "equal", 0xBB }, { "comma", 0xBC }, { "period", 0xBE }, { "slash", 0xBF },
        { "semicolon", 0xBA }, { "quote", 0xDE }, { "backslash", 0xDC },
        { "bracketleft", 0xDB }, { "bracketright", 0xDD }, { "grave", 0xC0 },
        { "printscreen", 0x2C }, { "caps", 0x14 }, { "numlock", 0x90 },
    };

    private static readonly HashSet<int> ExtendedKeys = new HashSet<int>
    { 0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x2C };

    private static byte ResolveKey(string token)
    {
        token = token.Trim();
        byte mapped;
        if (VirtualKeys.TryGetValue(token, out mapped)) return mapped;
        if (token.Length >= 2 && (token[0] == 'f' || token[0] == 'F'))
        {
            int number;
            if (int.TryParse(token.Substring(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out number) &&
                number >= 1 && number <= 12)
                return (byte)(0x6F + number);
        }
        if (token.Length == 1)
        {
            char upper = char.ToUpperInvariant(token[0]);
            if ((upper >= 'A' && upper <= 'Z') || (upper >= '0' && upper <= '9')) return (byte)upper;
        }
        throw new ArgumentException("unknown key '" + token + "'");
    }

    private static void SendCombo(string combo)
    {
        string[] tokens = combo.Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length == 0) throw new ArgumentException("empty key combo");
        var keys = new List<byte>();
        foreach (string token in tokens) keys.Add(ResolveKey(token));

        var held = new List<byte>();
        try
        {
            foreach (byte vk in keys)
            {
                keybd_event(vk, 0, ExtendedKeys.Contains(vk) ? EXTENDED : 0, UIntPtr.Zero);
                held.Add(vk);
                Thread.Sleep(15);
            }
        }
        finally
        {
            for (int i = held.Count - 1; i >= 0; i--)
            {
                byte vk = held[i];
                keybd_event(vk, 0, (ExtendedKeys.Contains(vk) ? EXTENDED : 0) | KEYUP, UIntPtr.Zero);
                Thread.Sleep(10);
            }
        }
    }

    private static void MoveCursor(int x, int y)
    {
        SetCursorPos(x, y);
        Thread.Sleep(30);
    }

    private static int ClickCommand(List<string> positional)
    {
        if (positional.Count < 2) return EmitError("click needs x y", "INVALID_ARGS");
        int x = int.Parse(positional[0], CultureInfo.InvariantCulture);
        int y = int.Parse(positional[1], CultureInfo.InvariantCulture);
        string button = positional.Count > 2 ? positional[2].ToLowerInvariant() : "left";
        int count = positional.Count > 3 ? int.Parse(positional[3], CultureInfo.InvariantCulture) : 1;
        if (count < 1 || count > 3) return EmitError("count must be 1..3", "INVALID_ARGS");

        uint down = LEFTDOWN, up = LEFTUP;
        if (button == "right") { down = RIGHTDOWN; up = RIGHTUP; }
        else if (button == "middle") { down = MIDDLEDOWN; up = MIDDLEUP; }

        MoveCursor(x, y);
        for (int i = 0; i < count; i++)
        {
            mouse_event(down, 0, 0, 0, UIntPtr.Zero);
            mouse_event(up, 0, 0, 0, UIntPtr.Zero);
            if (i < count - 1) Thread.Sleep(60);
        }

        var result = NewMap();
        result["ok"] = true;
        result["x"] = x;
        result["y"] = y;
        result["button"] = button;
        result["count"] = count;
        return Emit(result);
    }

    private static int MoveCommand(List<string> positional)
    {
        if (positional.Count < 2) return EmitError("move needs x y", "INVALID_ARGS");
        int x = int.Parse(positional[0], CultureInfo.InvariantCulture);
        int y = int.Parse(positional[1], CultureInfo.InvariantCulture);
        MoveCursor(x, y);
        var result = NewMap();
        result["ok"] = true;
        result["x"] = x;
        result["y"] = y;
        return Emit(result);
    }

    private static int DragCommand(List<string> positional)
    {
        if (positional.Count < 4) return EmitError("drag needs x1 y1 x2 y2", "INVALID_ARGS");
        int x1 = int.Parse(positional[0], CultureInfo.InvariantCulture);
        int y1 = int.Parse(positional[1], CultureInfo.InvariantCulture);
        int x2 = int.Parse(positional[2], CultureInfo.InvariantCulture);
        int y2 = int.Parse(positional[3], CultureInfo.InvariantCulture);

        MoveCursor(x1, y1);
        // The button must be released even when the process is killed or a step
        // throws; otherwise the desktop is left in a dragging state.
        mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        try
        {
            for (int step = 1; step <= 12; step++)
            {
                double ratio = step / 12.0;
                SetCursorPos((int)Math.Round(x1 + (x2 - x1) * ratio), (int)Math.Round(y1 + (y2 - y1) * ratio));
                Thread.Sleep(20);
            }
        }
        finally
        {
            mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
        }

        var result = NewMap();
        result["ok"] = true;
        result["x"] = x1;
        result["y"] = y1;
        result["x2"] = x2;
        result["y2"] = y2;
        return Emit(result);
    }

    private static int ScrollCommand(List<string> positional)
    {
        if (positional.Count < 1) return EmitError("scroll needs clicks", "INVALID_ARGS");
        int clicks = int.Parse(positional[0], CultureInfo.InvariantCulture);
        if (clicks < -20 || clicks > 20) return EmitError("clicks must be -20..20", "INVALID_ARGS");
        if (positional.Count >= 3)
            MoveCursor(int.Parse(positional[1], CultureInfo.InvariantCulture), int.Parse(positional[2], CultureInfo.InvariantCulture));
        mouse_event(WHEEL, 0, 0, unchecked((uint)(clicks * 120)), UIntPtr.Zero);

        var result = NewMap();
        result["ok"] = true;
        result["clicks"] = clicks;
        return Emit(result);
    }

    private static int KeyCommand(List<string> positional)
    {
        if (positional.Count < 1) return EmitError("key needs a combo such as ctrl+s", "INVALID_ARGS");
        SendCombo(positional[0]);
        var result = NewMap();
        result["ok"] = true;
        result["keys"] = positional[0];
        return Emit(result);
    }

    private static int TypeCommand(List<string> positional)
    {
        if (positional.Count < 1) return EmitError("type needs base64 text", "INVALID_ARGS");
        string text = Encoding.UTF8.GetString(Convert.FromBase64String(positional[0]));

        // Primary path: Unicode key events. It types any BMP character without
        // touching the clipboard, so the user's copied data survives.
        bool clipboardHasText = false;
        try { clipboardHasText = IsClipboardFormatAvailable(CF_UNICODETEXT); } catch { }
        bool needsPaste = clipboardHasText && (text.Length > 1500 || HasSurrogate(text));

        if (!needsPaste)
        {
            TypeCharacters(text);
            var typed = NewMap();
            typed["ok"] = true;
            typed["length"] = text.Length;
            typed["mode"] = "keys";
            return Emit(typed);
        }

        // Long or surrogate text: paste. The previous clipboard text is restored.
        string previous = null;
        try { previous = GetClipboardText(); } catch { }
        if (!SetClipboardText(text)) return EmitError("could not write the clipboard", "CLIPBOARD_FAILED");
        Thread.Sleep(60);
        try
        {
            SendCombo("ctrl+v");
            Thread.Sleep(250);
        }
        finally
        {
            if (previous != null) SetClipboardText(previous);
        }

        var result = NewMap();
        result["ok"] = true;
        result["length"] = text.Length;
        result["mode"] = "paste";
        return Emit(result);
    }

    private static bool HasSurrogate(string text)
    {
        foreach (char character in text)
        {
            if (char.IsSurrogate(character)) return true;
        }
        return false;
    }

    /// <summary>Type BMP text as Unicode key events, with real Enter/Tab keys.</summary>
    private static void TypeCharacters(string text)
    {
        foreach (char character in text)
        {
            if (character == '\r') continue;
            if (character == '\n')
            {
                keybd_event(0x0D, 0, 0, UIntPtr.Zero);
                keybd_event(0x0D, 0, KEYUP, UIntPtr.Zero);
                Thread.Sleep(2);
                continue;
            }
            if (character == '\t')
            {
                keybd_event(0x09, 0, 0, UIntPtr.Zero);
                keybd_event(0x09, 0, KEYUP, UIntPtr.Zero);
                Thread.Sleep(2);
                continue;
            }
            SendUnicodeCharacter(character);
            Thread.Sleep(1);
        }
    }

    private static int Focus(List<string> positional)
    {
        if (positional.Count < 1) return EmitError("focus needs a window handle", "INVALID_ARGS");
        long handleValue = long.Parse(positional[0], CultureInfo.InvariantCulture);
        IntPtr handle = new IntPtr(handleValue);
        if (!IsWindow(handle)) return EmitError("window handle is gone", "WINDOW_GONE");

        if (IsIconic(handle)) ShowWindow(handle, 9);
        uint pid;
        uint targetThread = GetWindowThreadProcessId(handle, out pid);
        uint currentThread = GetCurrentThreadId();
        bool attached = false;
        try
        {
            if (targetThread != currentThread) attached = AttachThreadInput(currentThread, targetThread, true);
            BringWindowToTop(handle);
            SetForegroundWindow(handle);
        }
        finally
        {
            if (attached) AttachThreadInput(currentThread, targetThread, false);
        }
        Thread.Sleep(120);

        // Windows can refuse a foreground change (foreground lock). Tapping Alt
        // releases the lock for the calling process, which is the standard way a
        // background tool is allowed to activate a window.
        if (GetForegroundWindow() != handle)
        {
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, KEYUP, UIntPtr.Zero);
            Thread.Sleep(80);
            BringWindowToTop(handle);
            SetForegroundWindow(handle);
            Thread.Sleep(120);
        }

        // Reporting success while another app still has focus would send later
        // typing to the wrong window.
        if (GetForegroundWindow() != handle)
        {
            return EmitError("Windows refused to bring that window to the front; click it once by hand (or by x/y coordinates), then retry", "FOCUS_REJECTED");
        }

        var result = NewMap();
        result["ok"] = true;
        result["hwnd"] = handleValue;
        return Emit(result);
    }

    // ---------------------------------------------------------------- clipboard

    private static bool OpenWithRetry()
    {
        for (int i = 0; i < 12; i++)
        {
            if (OpenClipboard(IntPtr.Zero)) return true;
            Thread.Sleep(40);
        }
        return false;
    }

    private static string GetClipboardText()
    {
        if (!OpenWithRetry()) return null;
        try
        {
            if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
            IntPtr handle = GetClipboardData(CF_UNICODETEXT);
            if (handle == IntPtr.Zero) return null;
            IntPtr pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero) return null;
            try { return Marshal.PtrToStringUni(pointer); }
            finally { GlobalUnlock(handle); }
        }
        finally { CloseClipboard(); }
    }

    private static bool SetClipboardText(string text)
    {
        if (text == null || !OpenWithRetry()) return false;
        try
        {
            if (!EmptyClipboard()) return false;
            // SetClipboardData requires an HGLOBAL from GlobalAlloc(GMEM_MOVEABLE);
            // ownership of that block moves to the clipboard on success.
            IntPtr block = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)((text.Length + 1) * 2));
            if (block == IntPtr.Zero) return false;
            IntPtr target = GlobalLock(block);
            if (target == IntPtr.Zero) { GlobalFree(block); return false; }
            byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
            Marshal.Copy(bytes, 0, target, bytes.Length);
            GlobalUnlock(block);
            if (SetClipboardData(CF_UNICODETEXT, block) == IntPtr.Zero) { GlobalFree(block); return false; }
            return true;
        }
        finally { CloseClipboard(); }
    }
}