// InsomniaZ automation helper (non-elevated).
//
// Runs as a child of the Electron main process and speaks JSON lines over
// stdin/stdout. Deliberately separate from InsomniaZHelper.exe (which is
// elevated and owns power/lid control): automation must share the integrity
// level of its targets and must never risk the power state.
//
// Channel choice per target, measured on the real apps:
//   ZCode            -> MSAA (oleacc) exposes the full DOM with physical rects
//   WorkBuddy        -> only an empty document; use PrintWindow + WinRT OCR
//   Electron targets -> UIA returns zero descendants without opt-in, so we do
//                       not use UIA here at all.
//
// All coordinates stay in physical pixels end to end.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Accessibility;

namespace InsomniaZ.Auto
{
    internal sealed class AutoException : Exception
    {
        public readonly string Code;
        public readonly bool Retryable;

        public AutoException(string code, string message, bool retryable)
            : base(message)
        {
            Code = code;
            Retryable = retryable;
        }
    }

    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct WINDOWPLACEMENT
        {
            public int Length;
            public int Flags;
            public int ShowCmd;
            public POINT MinPosition;
            public POINT MaxPosition;
            public RECT NormalPosition;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MEMORYSTATUSEX
        {
            public uint dwLength;
            public uint dwMemoryLoad;
            public ulong ullTotalPhys;
            public ulong ullAvailPhys;
            public ulong ullTotalPageFile;
            public ulong ullAvailPageFile;
            public ulong ullTotalVirtual;
            public ulong ullAvailVirtual;
            public ulong ullAvailExtendedVirtual;
        }

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int command);

        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll")]
        public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(POINT point);

        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr context);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern uint SendInput(uint count, INPUT[] inputs, int size);

        [DllImport("kernel32.dll")]
        public static extern bool GetSystemTimes(out FILETIME idle, out FILETIME kernel, out FILETIME user);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX status);

        [StructLayout(LayoutKind.Sequential)]
        public struct FILETIME
        {
            public uint Low;
            public uint High;

            public ulong ToUInt64()
            {
                return ((ulong)High << 32) | Low;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint Type;
            public InputUnion Data;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)]
            public KEYBDINPUT Keyboard;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort VirtualKey;
            public ushort ScanCode;
            public uint Flags;
            public uint Time;
            public IntPtr ExtraInfo;
        }

        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;

        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;

        public const int SW_HIDE = 0;
        public const int SW_SHOWNORMAL = 1;
        public const int SW_SHOWMINIMIZED = 2;
        public const int SW_SHOWMAXIMIZED = 3;
        public const int SW_SHOWNOACTIVATE = 4;
        public const int SW_MINIMIZE = 6;
        public const int SW_RESTORE = 9;

        public const int PW_RENDERFULLCONTENT = 2;
    }

    internal static class Program
    {
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private static readonly StreamReader Stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 65536);
        private static readonly StreamWriter Stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 65536) { AutoFlush = true };
        private static string _token = string.Empty;
        private static int _parentPid;
        private static string _logPath;

        [STAThread]
        private static int Main(string[] args)
        {
            Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
            Native.SetProcessDPIAware();

            for (var i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--token":
                        if (i + 1 < args.Length) _token = args[++i];
                        break;
                    case "--parent-pid":
                        if (i + 1 < args.Length) int.TryParse(args[++i], out _parentPid);
                        break;
                    case "--log":
                        if (i + 1 < args.Length) _logPath = args[++i];
                        break;
                }
            }

            if (_parentPid > 0) StartParentWatchdog(_parentPid);

            try
            {
                string line;
                while ((line = Stdin.ReadLine()) != null)
                {
                    if (line.Length == 0) continue;
                    HandleLine(line);
                }
            }
            catch (Exception ex)
            {
                Log("fatal: " + ex);
                return 1;
            }
            return 0;
        }

        private static void StartParentWatchdog(int pid)
        {
            var thread = new Thread(() =>
            {
                while (true)
                {
                    Thread.Sleep(2000);
                    try
                    {
                        var process = Process.GetProcessById(pid);
                        if (process.HasExited) break;
                    }
                    catch
                    {
                        Environment.Exit(0);
                    }
                }
                Environment.Exit(0);
            });
            thread.IsBackground = true;
            thread.Start();
        }

        private static void HandleLine(string line)
        {
            string id = null;
            try
            {
                var request = Json.Deserialize<Dictionary<string, object>>(line);
                if (request == null) return;
                id = AsString(Get(request, "id"));
                var token = AsString(Get(request, "token"));
                if (!string.IsNullOrEmpty(_token) && token != _token)
                {
                    Respond(id, false, null, "TOKEN_MISMATCH", "invalid token", false);
                    return;
                }
                var cmd = AsString(Get(request, "cmd"));
                var args = Get(request, "args") as Dictionary<string, object> ?? new Dictionary<string, object>();
                var data = Dispatch(cmd, args);
                Respond(id, true, data, null, null, false);
            }
            catch (AutoException ex)
            {
                Respond(id, false, null, ex.Code, ex.Message, ex.Retryable);
            }
            catch (Exception ex)
            {
                Log("command failed: " + ex);
                Respond(id, false, null, "UNEXPECTED_EXCEPTION", ex.Message, true);
            }
        }

        private static object Dispatch(string cmd, Dictionary<string, object> args)
        {
            switch (cmd)
            {
                case "hello":
                    return new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "version", "1.2.0" },
                        { "pid", Process.GetCurrentProcess().Id },
                        { "elevated", false },
                        { "ocr", Ocr.IsAvailable() }
                    };
                case "win.list":
                    return Windows.List(args);
                case "win.capture":
                    return Windows.Capture(args);
                case "win.show":
                    return Windows.Show(args);
                case "win.focus":
                    return Windows.Focus(args);
                case "win.probe":
                    return Windows.Probe(args);
                case "msaa.dump":
                    return Msaa.Dump(args);
                case "msaa.find":
                    return Msaa.Find(args);
                case "msaa.act":
                    return Msaa.Act(args);
                case "clip.read":
                    return Clipboard.ReadText();
                case "clip.write":
                    return Clipboard.WriteText(AsString(Get(args, "text")));
                case "clip.writeFiles":
                    return Clipboard.WriteFiles(StringList(Get(args, "files")));
                case "input.click":
                    return Input.Click(args);
                case "input.keys":
                    return Input.Keys(AsString(Get(args, "keys")));
                case "perf.sample":
                    return Perf.Sample();
                case "ocr.recognize":
                    return Ocr.Recognize(AsString(Get(args, "path")));
                case "ocr.languages":
                    return Ocr.Languages();
                default:
                    throw new AutoException("UNKNOWN_COMMAND", "unknown command: " + cmd, false);
            }
        }

        private static void Respond(string id, bool ok, object data, string code, string message, bool retryable)
        {
            var response = new Dictionary<string, object> { { "id", id }, { "ok", ok } };
            if (ok) response["data"] = data;
            else
            {
                response["error"] = new Dictionary<string, object>
                {
                    { "code", code },
                    { "message", message ?? string.Empty },
                    { "retryable", retryable }
                };
            }
            Stdout.WriteLine(Json.Serialize(response));
        }

        internal static void Log(string message)
        {
            if (string.IsNullOrEmpty(_logPath)) return;
            try
            {
                File.AppendAllText(_logPath, DateTime.Now.ToString("s") + " " + message + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
                // logging must never take the helper down
            }
        }

        internal static object Get(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) ? value : null;
        }

        internal static string AsString(object value)
        {
            return value == null ? null : value.ToString();
        }

        internal static int AsInt(object value, int fallback)
        {
            if (value == null) return fallback;
            try { return Convert.ToInt32(value); }
            catch { return fallback; }
        }

        internal static bool AsBool(object value, bool fallback)
        {
            if (value == null) return fallback;
            try { return Convert.ToBoolean(value); }
            catch { return fallback; }
        }

        internal static List<string> StringList(object value)
        {
            var list = new List<string>();
            var items = value as System.Collections.IEnumerable;
            if (items == null || value is string) return list;
            foreach (var item in items)
            {
                var text = AsString(item);
                if (!string.IsNullOrEmpty(text)) list.Add(text);
            }
            return list;
        }

        internal static List<int> IntList(object value)
        {
            var list = new List<int>();
            var items = value as System.Collections.IEnumerable;
            if (items == null || value is string) return list;
            foreach (var item in items) list.Add(AsInt(item, -1));
            return list;
        }
    }

    internal static class Windows
    {
        internal static Dictionary<string, object> List(Dictionary<string, object> args)
        {
            var filterPid = Program.AsInt(Program.Get(args, "pid"), 0);
            var includeInvisible = Program.AsBool(Program.Get(args, "includeInvisible"), false);
            var result = new List<Dictionary<string, object>>();
            Native.EnumWindows(delegate(IntPtr hwnd, IntPtr param)
            {
                uint pid;
                Native.GetWindowThreadProcessId(hwnd, out pid);
                if (filterPid > 0 && pid != filterPid) return true;
                if (pid == Process.GetCurrentProcess().Id) return true;
                var visible = Native.IsWindowVisible(hwnd);
                if (!visible && !includeInvisible) return true;
                var title = TitleOf(hwnd);
                var cls = ClassOf(hwnd);
                if (title.Length == 0 && cls.Length == 0) return true;
                result.Add(Describe(hwnd, pid, title, cls, visible));
                return true;
            }, IntPtr.Zero);
            return new Dictionary<string, object> { { "windows", result }, { "count", result.Count } };
        }

        internal static Dictionary<string, object> Describe(IntPtr hwnd, uint pid, string title, string cls, bool visible)
        {
            Native.RECT rect;
            Native.GetWindowRect(hwnd, out rect);
            var placement = new Native.WINDOWPLACEMENT();
            placement.Length = Marshal.SizeOf(typeof(Native.WINDOWPLACEMENT));
            Native.GetWindowPlacement(hwnd, ref placement);
            var processName = string.Empty;
            try { processName = Process.GetProcessById((int)pid).ProcessName; }
            catch { }
            return new Dictionary<string, object>
            {
                { "hwnd", hwnd.ToInt64() },
                { "pid", pid },
                { "title", title },
                { "class", cls },
                { "process", processName },
                { "visible", visible },
                { "minimized", Native.IsIconic(hwnd) },
                { "showCmd", placement.ShowCmd },
                { "rect", new[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top } },
                { "dpi", Native.GetDpiForWindow(hwnd) }
            };
        }

        internal static IntPtr Resolve(Dictionary<string, object> args)
        {
            var hwndValue = Program.Get(args, "hwnd");
            if (hwndValue != null)
            {
                var handle = new IntPtr(Convert.ToInt64(hwndValue.ToString()));
                if (handle == IntPtr.Zero) throw new AutoException("BAD_ARGS", "hwnd is zero", false);
                return handle;
            }
            var pid = Program.AsInt(Program.Get(args, "pid"), 0);
            if (pid <= 0) throw new AutoException("BAD_ARGS", "hwnd or pid required", false);
            var main = FindMain(pid);
            if (main == IntPtr.Zero) throw new AutoException("TARGET_NO_WINDOW", "no top-level window for pid " + pid, true);
            return main;
        }

        internal static IntPtr FindMain(int pid)
        {
            var best = IntPtr.Zero;
            var bestArea = 0;
            Native.EnumWindows(delegate(IntPtr hwnd, IntPtr param)
            {
                uint windowPid;
                Native.GetWindowThreadProcessId(hwnd, out windowPid);
                if (windowPid != (uint)pid) return true;
                if (!Native.IsWindowVisible(hwnd)) return true;
                var title = TitleOf(hwnd);
                var cls = ClassOf(hwnd);
                if (title.Length == 0) return true;
                if (cls.IndexOf("Intermediate D3D Window", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                Native.RECT rect;
                Native.GetWindowRect(hwnd, out rect);
                var area = Math.Max(0, rect.Right - rect.Left) * Math.Max(0, rect.Bottom - rect.Top);
                if (area > bestArea)
                {
                    bestArea = area;
                    best = hwnd;
                }
                return true;
            }, IntPtr.Zero);
            return best;
        }

        internal static Dictionary<string, object> Capture(Dictionary<string, object> args)
        {
            var hwnd = Resolve(args);
            var path = Program.AsString(Program.Get(args, "path"));
            if (string.IsNullOrEmpty(path)) throw new AutoException("BAD_ARGS", "path required", false);
            Native.RECT rect;
            if (!Native.GetWindowRect(hwnd, out rect)) throw new AutoException("WINDOW_GONE", "GetWindowRect failed", true);
            var width = Math.Max(1, rect.Right - rect.Left);
            var height = Math.Max(1, rect.Bottom - rect.Top);
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var captured = false;
            using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (var graphics = Graphics.FromImage(bitmap))
                {
                    var hdc = graphics.GetHdc();
                    try
                    {
                        captured = Native.PrintWindow(hwnd, hdc, Native.PW_RENDERFULLCONTENT);
                    }
                    finally
                    {
                        graphics.ReleaseHdc(hdc);
                    }
                }
                bitmap.Save(path, ImageFormat.Png);
            }
            return new Dictionary<string, object>
            {
                { "path", path },
                { "width", width },
                { "height", height },
                { "rect", new[] { rect.Left, rect.Top, width, height } },
                { "dpi", Native.GetDpiForWindow(hwnd) },
                { "printWindow", captured }
            };
        }

        internal static Dictionary<string, object> Show(Dictionary<string, object> args)
        {
            var hwnd = Resolve(args);
            var state = (Program.AsString(Program.Get(args, "state")) ?? "restore").ToLowerInvariant();
            int command;
            switch (state)
            {
                case "minimize": command = Native.SW_MINIMIZE; break;
                case "maximize": command = Native.SW_SHOWMAXIMIZED; break;
                case "hide": command = Native.SW_HIDE; break;
                case "noactivate": command = Native.SW_SHOWNOACTIVATE; break;
                case "restore": command = Native.SW_RESTORE; break;
                default: command = Native.SW_SHOWNORMAL; break;
            }
            var ok = Native.ShowWindow(hwnd, command);
            return new Dictionary<string, object> { { "ok", ok }, { "state", state } };
        }

        internal static Dictionary<string, object> Focus(Dictionary<string, object> args)
        {
            var hwnd = Resolve(args);
            if (Native.IsIconic(hwnd)) Native.ShowWindow(hwnd, Native.SW_RESTORE);
            var ok = Native.SetForegroundWindow(hwnd);
            if (!ok)
            {
                // Foreground lock workaround: a synthetic Alt tap releases the
                // restriction for the next SetForegroundWindow call.
                Input.TapKey(0x12);
                ok = Native.SetForegroundWindow(hwnd);
            }
            if (!ok)
            {
                var foreground = Native.GetForegroundWindow();
                if (foreground != IntPtr.Zero)
                {
                    uint foregroundPid;
                    var foregroundThread = Native.GetWindowThreadProcessId(foreground, out foregroundPid);
                    var currentThread = Native.GetCurrentThreadId();
                    if (Native.AttachThreadInput(currentThread, foregroundThread, true))
                    {
                        try { ok = Native.SetForegroundWindow(hwnd); }
                        finally { Native.AttachThreadInput(currentThread, foregroundThread, false); }
                    }
                }
            }
            Thread.Sleep(Program.AsInt(Program.Get(args, "settleMs"), 120));
            return new Dictionary<string, object>
            {
                { "ok", ok },
                { "foreground", Native.GetForegroundWindow().ToInt64() },
                { "hwnd", hwnd.ToInt64() }
            };
        }

        internal static Dictionary<string, object> Probe(Dictionary<string, object> args)
        {
            var hwnd = Resolve(args);
            var x = Program.AsInt(Program.Get(args, "x"), 0);
            var y = Program.AsInt(Program.Get(args, "y"), 0);
            var point = new Native.POINT { X = x, Y = y };
            var hit = Native.WindowFromPoint(point);
            return new Dictionary<string, object>
            {
                { "hit", hit.ToInt64() },
                { "target", hwnd.ToInt64() },
                { "matches", hit == hwnd },
                { "foreground", Native.GetForegroundWindow().ToInt64() }
            };
        }

        internal static string TitleOf(IntPtr hwnd)
        {
            var length = Native.GetWindowTextLength(hwnd);
            if (length <= 0) return string.Empty;
            var builder = new StringBuilder(length + 1);
            Native.GetWindowText(hwnd, builder, builder.Capacity);
            return builder.ToString();
        }

        internal static string ClassOf(IntPtr hwnd)
        {
            var builder = new StringBuilder(256);
            Native.GetClassName(hwnd, builder, builder.Capacity);
            return builder.ToString();
        }
    }

    internal static class Msaa
    {
        private const uint OBJID_CLIENT = 0xFFFFFFFC;
        private const int SELFLAG_TAKEFOCUS = 1;
        private const int SELFLAG_TAKESELECTION = 2;
        private const int MAX_NODES = 6000;
        private const int MAX_DEPTH = 40;

        [DllImport("oleacc.dll", EntryPoint = "AccessibleObjectFromWindow")]
        private static extern int AccessibleObjectFromWindowRaw(IntPtr hwnd, uint id, ref Guid riid, out IntPtr result);

        [DllImport("oleacc.dll")]
        private static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object result);

        private static readonly Guid IID_IAccessible = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");

        internal static IAccessible Root(IntPtr hwnd)
        {
            object raw;
            var iid = IID_IAccessible;
            var hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, ref iid, out raw);
            if (hr != 0 || raw == null) throw new AutoException("TREE_EMPTY", "AccessibleObjectFromWindow failed: 0x" + hr.ToString("X"), true);
            var accessible = raw as IAccessible;
            if (accessible == null) throw new AutoException("TREE_EMPTY", "root is not IAccessible", true);
            return accessible;
        }

        internal static Dictionary<string, object> Dump(Dictionary<string, object> args)
        {
            var hwnd = Windows.Resolve(args);
            var limit = Math.Min(MAX_NODES, Program.AsInt(Program.Get(args, "limit"), MAX_NODES));
            var maxDepth = Math.Min(MAX_DEPTH, Program.AsInt(Program.Get(args, "depth"), MAX_DEPTH));
            var nodes = new List<Dictionary<string, object>>();
            var root = Root(hwnd);
            try
            {
                Record(root, new List<int>(), 0, 0, nodes, limit);
                Walk(root, new List<int>(), 0, maxDepth, nodes, limit);
                var hash = Hash(nodes);
                return new Dictionary<string, object>
                {
                    { "count", nodes.Count },
                    { "hash", hash },
                    { "truncated", nodes.Count >= limit },
                    { "nodes", nodes }
                };
            }
            finally
            {
                Release(root);
            }
        }

        private static void Walk(IAccessible parent, List<int> path, int depth, int maxDepth, List<Dictionary<string, object>> nodes, int limit)
        {
            if (depth >= maxDepth || nodes.Count >= limit) return;
            int count;
            try { count = parent.accChildCount; }
            catch { return; }
            for (var i = 1; i <= count && nodes.Count < limit; i++)
            {
                object child = null;
                try { child = parent.get_accChild(i); }
                catch { child = null; }
                var childAccessible = child as IAccessible;
                if (childAccessible != null)
                {
                    var childPath = new List<int>(path) { i };
                    Record(childAccessible, childPath, 0, depth + 1, nodes, limit);
                    Walk(childAccessible, childPath, depth + 1, maxDepth, nodes, limit);
                    Release(childAccessible);
                }
                else
                {
                    Record(parent, path, i, depth + 1, nodes, limit);
                }
            }
        }

        private static void Record(IAccessible acc, List<int> path, int childId, int depth, List<Dictionary<string, object>> nodes, int limit)
        {
            if (nodes.Count >= limit) return;
            var node = new Dictionary<string, object>
            {
                { "path", string.Join(".", path.ToArray()) },
                { "ci", childId },
                { "depth", depth }
            };
            try { node["role"] = SafeInt(acc.get_accRole(childId)); }
            catch { node["role"] = 0; }
            try { node["state"] = SafeInt(acc.get_accState(childId)); }
            catch { node["state"] = 0; }
            try { node["name"] = Trim(acc.get_accName(childId), 300); }
            catch { node["name"] = string.Empty; }
            try { node["action"] = Trim(acc.get_accDefaultAction(childId), 120); }
            catch { node["action"] = string.Empty; }
            try
            {
                var value = acc.get_accValue(childId);
                if (!string.IsNullOrEmpty(value)) node["value"] = Trim(value, 200);
            }
            catch { }
            try { node["children"] = acc.accChildCount; }
            catch { node["children"] = 0; }
            int x = 0, y = 0, w = 0, h = 0;
            try
            {
                int left, top, width, height;
                acc.accLocation(out left, out top, out width, out height, childId);
                x = left; y = top;
                w = width; h = height;
            }
            catch { }
            node["rect"] = new[] { x, y, w, h };
            nodes.Add(node);
        }

        internal static Dictionary<string, object> Find(Dictionary<string, object> args)
        {
            var hwnd = Windows.Resolve(args);
            var name = Program.AsString(Program.Get(args, "name")) ?? string.Empty;
            var matchMode = (Program.AsString(Program.Get(args, "match")) ?? "exact").ToLowerInvariant();
            var roles = Program.IntList(Program.Get(args, "roles"));
            var stateMust = Program.IntList(Program.Get(args, "stateMust"));
            var stateNot = Program.IntList(Program.Get(args, "stateNot"));
            var stateAny = Program.IntList(Program.Get(args, "stateAny"));
            var max = Math.Min(200, Program.AsInt(Program.Get(args, "max"), 20));
            var allowEmptyName = Program.AsBool(Program.Get(args, "allowEmptyName"), false);
            var roleSet = new HashSet<int>(roles);
            var matches = new List<Dictionary<string, object>>();
            var root = Root(hwnd);
            try
            {
                Search(root, new List<int>(), 0, 0, new SearchFilter
                {
                    Name = name,
                    Mode = matchMode,
                    Roles = roleSet,
                    StateMust = stateMust,
                    StateNot = stateNot,
                    StateAny = stateAny,
                    AllowEmptyName = allowEmptyName
                }, matches, max);
                return new Dictionary<string, object>
                {
                    { "count", matches.Count },
                    { "matches", matches }
                };
            }
            finally
            {
                Release(root);
            }
        }

        private sealed class SearchFilter
        {
            public string Name;
            public string Mode;
            public HashSet<int> Roles;
            public List<int> StateMust;
            public List<int> StateNot;
            public List<int> StateAny;
            public bool AllowEmptyName;
        }

        private static void Search(IAccessible parent, List<int> path, int depth, int childId, SearchFilter filter, List<Dictionary<string, object>> matches, int max)
        {
            if (matches.Count >= max || depth > MAX_DEPTH) return;
            int role = 0, state = 0;
            string name = string.Empty;
            try { role = SafeInt(parent.get_accRole(childId)); }
            catch { }
            try { state = SafeInt(parent.get_accState(childId)); }
            catch { }
            try { name = parent.get_accName(childId) ?? string.Empty; }
            catch { }

            if (Matches(role, state, name, filter))
            {
                var node = new Dictionary<string, object>
                {
                    { "path", string.Join(".", path.ToArray()) },
                    { "ci", childId },
                    { "role", role },
                    { "state", state },
                    { "name", Trim(name, 300) }
                };
                try { node["action"] = Trim(parent.get_accDefaultAction(childId), 120); }
                catch { node["action"] = string.Empty; }
                int x = 0, y = 0, w = 0, h = 0;
                try
                {
                    int left, top, width, height;
                    parent.accLocation(out left, out top, out width, out height, childId);
                    x = left; y = top;
                    w = width; h = height;
                }
                catch { }
                node["rect"] = new[] { x, y, w, h };
                matches.Add(node);
            }

            int count;
            try { count = parent.accChildCount; }
            catch { return; }
            if (count <= 0 || depth >= MAX_DEPTH) return;
            for (var i = 1; i <= count && matches.Count < max; i++)
            {
                object child = null;
                try { child = parent.get_accChild(i); }
                catch { child = null; }
                var childAccessible = child as IAccessible;
                if (childAccessible != null)
                {
                    var childPath = new List<int>(path) { i };
                    Search(childAccessible, childPath, depth + 1, 0, filter, matches, max);
                    Release(childAccessible);
                }
                else
                {
                    Search(parent, path, depth + 1, i, filter, matches, max);
                }
            }
        }

        private static bool Matches(int role, int state, string name, SearchFilter filter)
        {
            if (filter.Roles.Count > 0 && !filter.Roles.Contains(role)) return false;
            for (var i = 0; i < filter.StateMust.Count; i++)
            {
                if ((state & filter.StateMust[i]) == 0) return false;
            }
            for (var i = 0; i < filter.StateNot.Count; i++)
            {
                if ((state & filter.StateNot[i]) != 0) return false;
            }
            if (filter.StateAny.Count > 0)
            {
                var any = false;
                for (var i = 0; i < filter.StateAny.Count; i++)
                {
                    if ((state & filter.StateAny[i]) != 0) { any = true; break; }
                }
                if (!any) return false;
            }
            if (string.IsNullOrEmpty(filter.Name))
            {
                return filter.AllowEmptyName || true;
            }
            if (string.IsNullOrEmpty(name)) return false;
            switch (filter.Mode)
            {
                case "contains":
                    return name.IndexOf(filter.Name, StringComparison.OrdinalIgnoreCase) >= 0;
                case "prefix":
                    return name.StartsWith(filter.Name, StringComparison.OrdinalIgnoreCase);
                case "regex":
                    try { return System.Text.RegularExpressions.Regex.IsMatch(name, filter.Name); }
                    catch { return false; }
                default:
                    return string.Equals(name.Trim(), filter.Name.Trim(), StringComparison.OrdinalIgnoreCase);
            }
        }

        internal static Dictionary<string, object> Act(Dictionary<string, object> args)
        {
            var hwnd = Windows.Resolve(args);
            var action = (Program.AsString(Program.Get(args, "action")) ?? "invoke").ToLowerInvariant();
            var root = Root(hwnd);
            try
            {
                var node = Locate(root, args);
                var acc = (IAccessible)node[0];
                var path = (List<int>)node[1];
                var childId = (int)node[2];
                switch (action)
                {
                    case "focus":
                        acc.accSelect(SELFLAG_TAKEFOCUS | SELFLAG_TAKESELECTION, childId);
                        return new Dictionary<string, object> { { "ok", true }, { "action", action } };
                    case "invoke":
                        acc.accDoDefaultAction(childId);
                        return new Dictionary<string, object> { { "ok", true }, { "action", action } };
                    case "setvalue":
                        acc.set_accValue(childId, Program.AsString(Program.Get(args, "value")) ?? string.Empty);
                        return new Dictionary<string, object> { { "ok", true }, { "action", action } };
                    case "state":
                    {
                        int state;
                        try { state = SafeInt(acc.get_accState(childId)); }
                        catch { state = 0; }
                        return new Dictionary<string, object> { { "state", state }, { "path", string.Join(".", path.ToArray()) }, { "ci", childId } };
                    }
                    case "click":
                    {
                        int x, y, w, h;
                        Location(acc, childId, out x, out y, out w, out h);
                        if (w <= 0 || h <= 0) throw new AutoException("NODE_NO_RECT", "node has no clickable rect", true);
                        var at = (Program.AsString(Program.Get(args, "at")) ?? "center").ToLowerInvariant();
                        var px = x + w / 2;
                        if (at == "right") px = x + w - Math.Max(3, Math.Min(10, w / 6));
                        if (at == "left") px = x + Math.Max(3, Math.Min(10, w / 6));
                        px += Program.AsInt(Program.Get(args, "offsetX"), 0);
                        var py = y + h / 2 + Program.AsInt(Program.Get(args, "offsetY"), 0);
                        Input.ClickAt(px, py);
                        return new Dictionary<string, object> { { "ok", true }, { "x", px }, { "y", py }, { "rect", new[] { x, y, w, h } } };
                    }
                    case "rect":
                    {
                        int x, y, w, h;
                        Location(acc, childId, out x, out y, out w, out h);
                        return new Dictionary<string, object> { { "rect", new[] { x, y, w, h } }, { "path", string.Join(".", path.ToArray()) }, { "ci", childId } };
                    }
                    default:
                        throw new AutoException("UNKNOWN_ACTION", "unknown action: " + action, false);
                }
            }
            finally
            {
                Release(root);
            }
        }

        private static object[] Locate(IAccessible root, Dictionary<string, object> args)
        {
            int childId = Program.AsInt(Program.Get(args, "ci"), 0);
            var pathText = Program.AsString(Program.Get(args, "path"));
            if (!string.IsNullOrEmpty(pathText))
            {
                var acc = root;
                foreach (var part in pathText.Split('.'))
                {
                    if (part.Length == 0) continue;
                    var index = int.Parse(part);
                    object child = null;
                    try { child = acc.get_accChild(index); }
                    catch { child = null; }
                    var next = child as IAccessible;
                    if (next == null) throw new AutoException("NODE_GONE", "path no longer resolves: " + pathText, true);
                    acc = next;
                }
                return new object[] { acc, new List<int>(), childId };
            }

            var name = Program.AsString(Program.Get(args, "name"));
            if (string.IsNullOrEmpty(name)) throw new AutoException("BAD_ARGS", "path or name required", false);
            var roles = Program.IntList(Program.Get(args, "roles"));
            var found = FindFirst(root, name, (Program.AsString(Program.Get(args, "match")) ?? "exact").ToLowerInvariant(), new HashSet<int>(roles));
            if (found == null) throw new AutoException("NODE_GONE", "node not found: " + name, true);
            return found;
        }

        private static object[] FindFirst(IAccessible parent, string name, string mode, HashSet<int> roles)
        {
            return FindFirstInternal(parent, name, mode, roles, new List<int>(), 0, 0);
        }

        private static object[] FindFirstInternal(IAccessible parent, string name, string mode, HashSet<int> roles, List<int> path, int depth, int childId)
        {
            if (depth > MAX_DEPTH) return null;
            string current = string.Empty;
            int role = 0;
            try { current = parent.get_accName(childId) ?? string.Empty; }
            catch { }
            try { role = SafeInt(parent.get_accRole(childId)); }
            catch { }
            var roleOk = roles.Count == 0 || roles.Contains(role);
            var nameOk = mode == "contains"
                ? current.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0
                : string.Equals(current.Trim(), name.Trim(), StringComparison.OrdinalIgnoreCase);
            if (roleOk && nameOk && current.Length > 0) return new object[] { parent, new List<int>(path), childId };

            int count;
            try { count = parent.accChildCount; }
            catch { return null; }
            for (var i = 1; i <= count; i++)
            {
                object child = null;
                try { child = parent.get_accChild(i); }
                catch { child = null; }
                var childAccessible = child as IAccessible;
                if (childAccessible != null)
                {
                    var childPath = new List<int>(path) { i };
                    var result = FindFirstInternal(childAccessible, name, mode, roles, childPath, depth + 1, 0);
                    if (result != null) return result;
                    Release(childAccessible);
                }
                else
                {
                    var result = FindFirstInternal(parent, name, mode, roles, path, depth + 1, i);
                    if (result != null) return result;
                }
            }
            return null;
        }

        internal static void Location(IAccessible acc, int childId, out int x, out int y, out int w, out int h)
        {
            x = y = w = h = 0;
            try
            {
                int left, top, width, height;
                acc.accLocation(out left, out top, out width, out height, childId);
                x = left; y = top;
                w = width; h = height;
            }
            catch
            {
                // leave zeroes; callers treat them as "no rect"
            }
        }

        internal static int SafeInt(object value)
        {
            if (value == null) return 0;
            if (value is int) return (int)value;
            int parsed;
            return int.TryParse(value.ToString(), out parsed) ? parsed : 0;
        }

        internal static string Trim(string value, int max)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            return value.Length <= max ? value : value.Substring(0, max);
        }

        internal static void Release(object com)
        {
            try
            {
                if (com != null && Marshal.IsComObject(com)) Marshal.ReleaseComObject(com);
            }
            catch { }
        }

        private static string Hash(List<Dictionary<string, object>> nodes)
        {
            var builder = new StringBuilder();
            foreach (var node in nodes)
            {
                builder.Append(Program.AsString(Program.Get(node, "name")));
                builder.Append('|');
                builder.Append(Program.AsString(Program.Get(node, "role")));
                builder.Append('|');
                var rect = Program.Get(node, "rect") as int[];
                if (rect != null) builder.Append(rect[0]).Append(',').Append(rect[1]).Append(',').Append(rect[2]);
                builder.Append('\n');
                if (builder.Length > 2000000) break;
            }
            using (var sha = SHA1.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(builder.ToString()));
                return BitConverter.ToString(bytes).Replace("-", string.Empty).ToLowerInvariant();
            }
        }
    }

    internal static class Clipboard
    {
        [DllImport("user32.dll")]
        private static extern uint GetClipboardSequenceNumber();

        internal static Dictionary<string, object> ReadText()
        {
            var text = string.Empty;
            var files = new List<string>();
            for (var attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    text = System.Windows.Forms.Clipboard.ContainsText() ? System.Windows.Forms.Clipboard.GetText() : string.Empty;
                    if (System.Windows.Forms.Clipboard.ContainsFileDropList())
                    {
                        foreach (var file in System.Windows.Forms.Clipboard.GetFileDropList()) files.Add(file);
                    }
                    return new Dictionary<string, object>
                    {
                        { "text", text },
                        { "files", files },
                        { "sequence", GetClipboardSequenceNumber() }
                    };
                }
                catch
                {
                    Thread.Sleep(50);
                }
            }
            throw new AutoException("CLIPBOARD_OCCUPIED", "clipboard is locked by another process", true);
        }

        internal static Dictionary<string, object> WriteText(string text)
        {
            for (var attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    System.Windows.Forms.Clipboard.SetText(text ?? string.Empty);
                    return new Dictionary<string, object> { { "ok", true }, { "length", (text ?? string.Empty).Length } };
                }
                catch
                {
                    Thread.Sleep(50);
                }
            }
            throw new AutoException("CLIPBOARD_OCCUPIED", "could not write to clipboard", true);
        }

        internal static Dictionary<string, object> WriteFiles(List<string> files)
        {
            if (files.Count == 0) throw new AutoException("BAD_ARGS", "files required", false);
            var collection = new System.Collections.Specialized.StringCollection();
            foreach (var file in files)
            {
                if (!File.Exists(file)) throw new AutoException("ATTACHMENT_MISSING", "file not found: " + file, false);
                collection.Add(file);
            }
            for (var attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    System.Windows.Forms.Clipboard.SetFileDropList(collection);
                    return new Dictionary<string, object> { { "ok", true }, { "count", collection.Count } };
                }
                catch
                {
                    Thread.Sleep(50);
                }
            }
            throw new AutoException("CLIPBOARD_OCCUPIED", "could not write file list to clipboard", true);
        }
    }

    internal static class Input
    {
        private static readonly Dictionary<string, ushort> KeyMap = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
        {
            { "ctrl", 0x11 }, { "control", 0x11 }, { "alt", 0x12 }, { "shift", 0x10 },
            { "win", 0x5B }, { "enter", 0x0D }, { "return", 0x0D }, { "esc", 0x1B }, { "escape", 0x1B },
            { "tab", 0x09 }, { "space", 0x20 }, { "backspace", 0x08 }, { "delete", 0x2E },
            { "insert", 0x2D }, { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 },
            { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
            { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 }, { "f5", 0x74 }, { "f6", 0x75 },
            { "f7", 0x76 }, { "f8", 0x77 }, { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B }
        };

        internal static Dictionary<string, object> Click(Dictionary<string, object> args)
        {
            var x = Program.AsInt(Program.Get(args, "x"), -1);
            var y = Program.AsInt(Program.Get(args, "y"), -1);
            if (x < 0 || y < 0) throw new AutoException("BAD_ARGS", "x and y required", false);
            var moveOnly = Program.AsBool(Program.Get(args, "moveOnly"), false);
            ClickAt(x, y, moveOnly);
            return new Dictionary<string, object> { { "ok", true }, { "x", x }, { "y", y }, { "clicked", !moveOnly } };
        }

        internal static void ClickAt(int x, int y)
        {
            ClickAt(x, y, false);
        }

        internal static void ClickAt(int x, int y, bool moveOnly)
        {
            Native.SetCursorPos(x, y);
            Thread.Sleep(30);
            if (moveOnly) return;
            Native.mouse_event(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(30);
            Native.mouse_event(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(40);
        }

        internal static Dictionary<string, object> Keys(string combo)
        {
            if (string.IsNullOrEmpty(combo)) throw new AutoException("BAD_ARGS", "keys required", false);
            var pressed = new List<ushort>();
            var sequence = combo.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (var token in sequence)
            {
                var parts = token.Split('+');
                var keys = new List<ushort>();
                foreach (var part in parts)
                {
                    keys.Add(ResolveKey(part));
                }
                for (var i = 0; i < keys.Count; i++) Send(keys[i], false);
                for (var i = keys.Count - 1; i >= 0; i--) Send(keys[i], true);
                Thread.Sleep(20);
            }
            return new Dictionary<string, object> { { "ok", true }, { "keys", combo } };
        }

        private static ushort ResolveKey(string name)
        {
            ushort mapped;
            if (KeyMap.TryGetValue(name.Trim(), out mapped)) return mapped;
            if (name.Length == 1)
            {
                var upper = char.ToUpperInvariant(name[0]);
                return (ushort)upper;
            }
            throw new AutoException("BAD_ARGS", "unknown key: " + name, false);
        }

        internal static void TapKey(ushort key)
        {
            Send(key, false);
            Thread.Sleep(20);
            Send(key, true);
        }

        private static void Send(ushort key, bool up)
        {
            var input = new Native.INPUT
            {
                Type = Native.INPUT_KEYBOARD,
                Data = new Native.InputUnion
                {
                    Keyboard = new Native.KEYBDINPUT
                    {
                        VirtualKey = key,
                        Flags = up ? Native.KEYEVENTF_KEYUP : 0,
                        Time = 0,
                        ExtraInfo = IntPtr.Zero
                    }
                }
            };
            var inputs = new[] { input };
            Native.SendInput(1, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
        }
    }

    internal static class Perf
    {
        private static ulong _prevIdle;
        private static ulong _prevKernel;
        private static ulong _prevUser;
        private static readonly object Gate = new object();

        internal static Dictionary<string, object> Sample()
        {
            lock (Gate)
            {
                Native.FILETIME idle, kernel, user;
                if (!Native.GetSystemTimes(out idle, out kernel, out user))
                {
                    throw new AutoException("UNEXPECTED_EXCEPTION", "GetSystemTimes failed", true);
                }
                var idleValue = idle.ToUInt64();
                var kernelValue = kernel.ToUInt64();
                var userValue = user.ToUInt64();
                double busy = 0;
                if (_prevKernel != 0)
                {
                    var idleDelta = idleValue - _prevIdle;
                    var totalDelta = (kernelValue - _prevKernel) + (userValue - _prevUser);
                    if (totalDelta > 0) busy = 1.0 - (double)idleDelta / totalDelta;
                }
                _prevIdle = idleValue;
                _prevKernel = kernelValue;
                _prevUser = userValue;

                var status = new Native.MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf(typeof(Native.MEMORYSTATUSEX)) };
                Native.GlobalMemoryStatusEx(ref status);
                var process = Process.GetCurrentProcess();
                return new Dictionary<string, object>
                {
                    { "cpuBusy", Math.Round(Math.Min(1.0, Math.Max(0.0, busy)), 3) },
                    { "memoryLoad", Math.Round(status.dwMemoryLoad / 100.0, 3) },
                    { "totalMemory", status.ullTotalPhys },
                    { "availableMemory", status.ullAvailPhys },
                    { "handles", process.HandleCount },
                    { "workingSet", process.WorkingSet64 },
                    { "takenAt", DateTime.UtcNow.ToString("o") }
                };
            }
        }
    }

    internal static class Ocr
    {
        internal static bool IsAvailable()
        {
            try
            {
                return global::Windows.Media.Ocr.OcrEngine.AvailableRecognizerLanguages.Count > 0;
            }
            catch
            {
                return false;
            }
        }

        internal static Dictionary<string, object> Languages()
        {
            var list = new List<string>();
            try
            {
                foreach (var language in global::Windows.Media.Ocr.OcrEngine.AvailableRecognizerLanguages)
                {
                    list.Add(language.LanguageTag);
                }
            }
            catch (Exception ex)
            {
                throw new AutoException("OCR_ENGINE_MISSING", ex.Message, false);
            }
            return new Dictionary<string, object> { { "languages", list } };
        }

        internal static Dictionary<string, object> Recognize(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                throw new AutoException("BAD_ARGS", "image not found: " + path, false);
            }
            try
            {
                return RecognizeAsync(path).GetAwaiter().GetResult();
            }
            catch (AutoException)
            {
                throw;
            }
            catch (Exception ex)
            {
                throw new AutoException("OCR_ENGINE_MISSING", ex.Message, true);
            }
        }

        private static async System.Threading.Tasks.Task<Dictionary<string, object>> RecognizeAsync(string path)
        {
            var file = await global::Windows.Storage.StorageFile.GetFileFromPathAsync(path);
            var stream = await file.OpenAsync(global::Windows.Storage.FileAccessMode.Read);
            try
            {
                var decoder = await global::Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(stream);
                var bitmap = await decoder.GetSoftwareBitmapAsync();
                var engine = CreateEngine();
                if (engine == null) throw new AutoException("OCR_ENGINE_MISSING", "no OCR recognizer installed", false);
                var result = await engine.RecognizeAsync(bitmap);
                var lines = new List<Dictionary<string, object>>();
                foreach (var line in result.Lines)
                {
                    var words = new List<Dictionary<string, object>>();
                    double minX = double.MaxValue, minY = double.MaxValue, maxX = 0, maxY = 0;
                    foreach (var word in line.Words)
                    {
                        var rect = word.BoundingRect;
                        var x = (int)Math.Round(rect.X);
                        var y = (int)Math.Round(rect.Y);
                        var w = (int)Math.Round(rect.Width);
                        var h = (int)Math.Round(rect.Height);
                        words.Add(new Dictionary<string, object>
                        {
                            { "t", word.Text },
                            { "x", x }, { "y", y }, { "w", w }, { "h", h }
                        });
                        if (x < minX) minX = x;
                        if (y < minY) minY = y;
                        if (x + w > maxX) maxX = x + w;
                        if (y + h > maxY) maxY = y + h;
                    }
                    if (words.Count == 0) continue;
                    lines.Add(new Dictionary<string, object>
                    {
                        { "text", line.Text },
                        { "x", (int)minX }, { "y", (int)minY },
                        { "w", (int)(maxX - minX) }, { "h", (int)(maxY - minY) },
                        { "words", words }
                    });
                }
                return new Dictionary<string, object>
                {
                    { "language", engine.RecognizerLanguage.LanguageTag },
                    { "width", (int)decoder.PixelWidth },
                    { "height", (int)decoder.PixelHeight },
                    { "lineCount", lines.Count },
                    { "lines", lines }
                };
            }
            finally
            {
                stream.Dispose();
            }
        }

        private static global::Windows.Media.Ocr.OcrEngine CreateEngine()
        {
            try
            {
                var engine = global::Windows.Media.Ocr.OcrEngine.TryCreateFromLanguage(new global::Windows.Globalization.Language("zh-Hans-CN"));
                if (engine != null) return engine;
            }
            catch { }
            try
            {
                var engine = global::Windows.Media.Ocr.OcrEngine.TryCreateFromUserProfileLanguages();
                if (engine != null) return engine;
            }
            catch { }
            try
            {
                var engine = global::Windows.Media.Ocr.OcrEngine.TryCreateFromLanguage(new global::Windows.Globalization.Language("en-US"));
                if (engine != null) return engine;
            }
            catch { }
            return null;
        }
    }
}
