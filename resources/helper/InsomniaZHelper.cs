using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using Accessibility;

[assembly: AssemblyTitle("InsomniaZ Power Helper")]
[assembly: AssemblyDescription("Keeps Windows awake, manages the lid power policy and drives the GUI fallback for InsomniaZ.")]
[assembly: AssemblyProduct("InsomniaZ")]
[assembly: AssemblyVersion("1.2.0.0")]
[assembly: AssemblyFileVersion("1.2.0.0")]

internal static class InsomniaZHelper
{
    private const string Version = "1.2.0";
    private const uint ES_CONTINUOUS = 0x80000000u;
    private const uint ES_SYSTEM_REQUIRED = 0x00000001u;
    private const uint ES_DISPLAY_REQUIRED = 0x00000002u;
    private const ushort VK_F15 = 0x7E;

    private static Guid SUB_BUTTONS = new Guid("4f971e89-eebd-4455-a8de-9e59040e7347");
    private static Guid LID_ACTION = new Guid("5ca83367-6e45-459f-a27b-476b1d01c936");

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly object LogLock = new object();
    private static string _logPath;

    private static int Main(string[] args)
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { SetProcessDPIAware(); } catch { } }
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        var options = ParseArgs(args);
        _logPath = Get(options, "log");
        Log("info", "helper starting; elevated=" + IsElevated());

        if (options.ContainsKey("probe"))
        {
            string probePath = options["probe"];
            bool jiggle = options.ContainsKey("jiggle");
            Dictionary<string, object> probe = BuildStatus();
            if (jiggle)
            {
                int before = GetIdleMs();
                SendActivity();
                Thread.Sleep(180);
                probe["jiggle"] = new Dictionary<string, object> {
                    { "idleBefore", before },
                    { "idleAfter", GetIdleMs() }
                };
            }
            WriteAllTextAtomic(probePath, Json.Serialize(probe));
            return 0;
        }

        string pipeName = Get(options, "pipe");
        string token = Get(options, "token");
        string parentRaw = Get(options, "parent-pid");
        string recoveryPath = Get(options, "recovery");
        int parentPid = 0;
        int.TryParse(parentRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out parentPid);
        if (string.IsNullOrEmpty(pipeName) || string.IsNullOrEmpty(token) || parentPid <= 0)
        {
            Log("error", "missing required arguments");
            return 2;
        }

        var runtime = new HelperRuntime(pipeName, token, parentPid, recoveryPath);
        return runtime.Run();
    }

    private static Dictionary<string, string> ParseArgs(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            if (!arg.StartsWith("--", StringComparison.Ordinal)) continue;
            string key = arg.Substring(2);
            if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                result[key] = args[i + 1];
                i++;
            }
            else
            {
                result[key] = "true";
            }
        }
        return result;
    }

    private static string Get(Dictionary<string, string> options, string key)
    {
        string value;
        return options.TryGetValue(key, out value) ? value : null;
    }

    internal static void Log(string level, string message)
    {
        string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture)
            + " [" + level + "] " + message;
        Debug.WriteLine(line);
        if (string.IsNullOrEmpty(_logPath)) return;
        try
        {
            lock (LogLock)
            {
                string dir = Path.GetDirectoryName(_logPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                var info = new FileInfo(_logPath);
                if (info.Exists && info.Length > 1024 * 1024)
                {
                    string old = _logPath + ".old";
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(_logPath, old);
                }
                File.AppendAllText(_logPath, line + Environment.NewLine, new UTF8Encoding(false));
            }
        }
        catch
        {
            // Logging must never break the helper.
        }
    }

    internal static bool IsElevated()
    {
        try
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                var principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
        }
        catch
        {
            return false;
        }
    }

    internal static void WriteAllTextAtomic(string path, string content)
    {
        string dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
        string tmp = path + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        if (File.Exists(path))
        {
            string backup = path + ".bak";
            try
            {
                File.Replace(tmp, path, backup);
                try { if (File.Exists(backup)) File.Delete(backup); } catch { }
            }
            catch
            {
                File.Copy(tmp, path, true);
                File.Delete(tmp);
            }
        }
        else
        {
            File.Move(tmp, path);
        }
    }

    internal static Dictionary<string, object> BuildStatus()
    {
        var status = new Dictionary<string, object>();
        status["version"] = Version;
        status["elevated"] = IsElevated();
        status["helperPid"] = Process.GetCurrentProcess().Id;
        status["idleMs"] = GetIdleMs();
        status["execution"] = new Dictionary<string, object> {
            { "active", false },
            { "system", false },
            { "display", false }
        };

        Guid scheme;
        uint ac, dc, rcAc, rcDc;
        bool read = PowerApi.TryReadLid(out scheme, out ac, out dc, out rcAc, out rcDc);
        status["lidSupported"] = read;
        status["scheme"] = read ? scheme.ToString() : null;
        status["lidAc"] = read ? (object)ac : null;
        status["lidDc"] = read ? (object)dc : null;
        status["lidReadAcError"] = rcAc;
        status["lidReadDcError"] = rcDc;
        status["lidApplied"] = false;
        status["recoveryPending"] = false;
        status["battery"] = GetBattery();
        return status;
    }

    internal static Dictionary<string, object> GetBattery()
    {
        var result = new Dictionary<string, object>();
        SYSTEM_POWER_STATUS status;
        if (!GetSystemPowerStatus(out status))
        {
            result["available"] = false;
            return result;
        }
        bool present = status.BatteryFlag != 128;
        result["available"] = true;
        result["ac"] = status.ACLineStatus == 1;
        result["present"] = present;
        result["percent"] = status.BatteryLifePercent == 255 ? (object)null : status.BatteryLifePercent;
        result["charging"] = (status.BatteryFlag & 8) == 8;
        return result;
    }

    internal static int GetIdleMs()
    {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info)) return -1;
        return unchecked((int)(GetTickCount() - info.dwTime));
    }

    internal static bool SendActivity()
    {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = 1;
        inputs[0].Data.ki.wVk = VK_F15;
        inputs[1].type = 1;
        inputs[1].Data.ki.wVk = VK_F15;
        inputs[1].Data.ki.dwFlags = 0x0002;
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length)
        {
            Log("warn", "SendInput failed; win32=" + Marshal.GetLastWin32Error());
            return false;
        }
        return true;
    }

    private sealed class HelperRuntime
    {
        private readonly string _pipeName;
        private readonly string _token;
        private readonly int _parentPid;
        private readonly string _recoveryPath;
        private readonly object _writeLock = new object();
        private readonly object _lidLock = new object();
        private readonly object _execLock = new object();

        private NamedPipeClientStream _pipe;
        private StreamReader _reader;
        private StreamWriter _writer;

        private volatile bool _shuttingDown;
        private volatile bool _execSystem;
        private volatile bool _execDisplay;
        private int _cleanupStarted;
        private Thread _execThread;
        private Thread _parentThread;
        private Thread _lidThread;

        private bool _lidApplied;
        private Guid _appliedScheme;
        private uint _originalAc;
        private uint _originalDc;

        public HelperRuntime(string pipeName, string token, int parentPid, string recoveryPath)
        {
            _pipeName = pipeName;
            _token = token;
            _parentPid = parentPid;
            _recoveryPath = recoveryPath;
        }

        public int Run()
        {
            if (!Connect())
            {
                Log("error", "could not connect to pipe " + _pipeName);
                return 3;
            }

            StartExecutionThread();
            StartParentWatch();
            StartLidWatch();
            try
            {
                AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
                Microsoft.Win32.SystemEvents.SessionEnding += OnSessionEnding;
            }
            catch { }

            try
            {
                while (!_shuttingDown)
                {
                    string line = _reader.ReadLine();
                    if (line == null)
                    {
                        Log("info", "pipe closed; cleaning up");
                        break;
                    }
                    HandleLine(line);
                }
            }
            catch (Exception ex)
            {
                Log("error", "pipe loop failed: " + ex.Message);
            }
            finally
            {
                Cleanup();
            }
            return 0;
        }

        private bool Connect()
        {
            for (int attempt = 0; attempt < 40 && !_shuttingDown; attempt++)
            {
                try
                {
                    var pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.None,
                        TokenImpersonationLevel.Identification);
                    pipe.Connect(1000);
                    _pipe = pipe;
                    _reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true);
                    _writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true);
                    _writer.AutoFlush = true;
                    Log("info", "connected to pipe");
                    return true;
                }
                catch (Exception ex)
                {
                    if (attempt == 39) Log("warn", "pipe connect failed: " + ex.Message);
                    Thread.Sleep(500);
                }
            }
            return false;
        }

        private void HandleLine(string line)
        {
            Dictionary<string, object> request;
            try
            {
                request = Json.Deserialize<Dictionary<string, object>>(line);
            }
            catch
            {
                Send(new Dictionary<string, object> {
                    { "id", 0 },
                    { "ok", false },
                    { "error", Error("INVALID_ARGUMENT", "Malformed JSON.") }
                });
                return;
            }

            object idObj;
            request.TryGetValue("id", out idObj);
            int id = ToInt(idObj, 0);

            string token = GetString(request, "token");
            if (!string.Equals(token, _token, StringComparison.Ordinal))
            {
                Send(Response(id, false, null, Error("UNAUTHORIZED", "Invalid helper token.")));
                return;
            }

            string cmd = GetString(request, "cmd");
            Dictionary<string, object> args = GetDict(request, "args");
            Log("info", "command " + cmd);

            try
            {
                if (cmd == "hello" || cmd == "status")
                {
                    Send(Response(id, true, StatusData(), null));
                }
                else if (cmd == "setExecution")
                {
                    _execSystem = GetBool(args, "system");
                    _execDisplay = GetBool(args, "display");
                    ApplyExecutionState();
                    Send(Response(id, true, ExecutionData(), null));
                }
                else if (cmd == "jiggle")
                {
                    int before = GetIdleMs();
                    bool ok = SendActivity();
                    Thread.Sleep(80);
                    int after = GetIdleMs();
                    var data = new Dictionary<string, object> {
                        { "sent", ok },
                        { "idleBefore", before },
                        { "idleAfter", after }
                    };
                    Send(Response(id, true, data, ok ? null : Error("INPUT_FAILED", "SendInput was rejected.")));
                }
                else if (cmd == "applyLid")
                {
                    string code;
                    string message;
                    bool ok = ApplyLid(out code, out message);
                    Send(Response(id, ok, LidData(), ok ? null : Error(code, message)));
                }
                else if (cmd == "restoreLid")
                {
                    string code;
                    string message;
                    bool ok = RestoreLid(out code, out message);
                    Send(Response(id, ok, LidData(), ok ? null : Error(code, message)));
                }
                else if (cmd == "recover")
                {
                    string code;
                    string message;
                    bool ok = RecoverFromFile(out code, out message);
                    Send(Response(id, ok, StatusData(), ok ? null : Error(code, message)));
                }
                else if (cmd == "uia.scan")
                {
                    Send(Response(id, true, GuiAutomation.Scan(args), null));
                }
                else if (cmd == "uia.act")
                {
                    Send(Response(id, true, GuiAutomation.Act(args), null));
                }
                else if (cmd == "uia.record.start")
                {
                    Send(Response(id, true, MouseRecorder.Start(args), null));
                }
                else if (cmd == "uia.record.stop")
                {
                    Send(Response(id, true, MouseRecorder.Stop(), null));
                }
                else if (cmd == "uia.record.status")
                {
                    Send(Response(id, true, MouseRecorder.Status(), null));
                }
                else if (cmd == "suspend")
                {
                    if (!string.Equals(GetString(args, "reason"), "soft-stop", StringComparison.Ordinal))
                    {
                        throw new HelperException("INVALID_ARGUMENT", "suspend requires reason=soft-stop.");
                    }
                    Send(Response(id, true, new Dictionary<string, object> { { "accepted", true } }, null));
                    ThreadPool.QueueUserWorkItem(delegate
                    {
                        try
                        {
                            Thread.Sleep(700);
                            Log("warn", "soft stop requested protective sleep");
                            SetThreadExecutionState(ES_CONTINUOUS);
                            bool ok = SetSuspendState(false, true, false);
                            if (!ok) Log("warn", "SetSuspendState failed; win32=" + Marshal.GetLastWin32Error());
                        }
                        catch (Exception ex)
                        {
                            Log("error", "protective sleep failed: " + ex.Message);
                        }
                    });
                }
                else if (cmd == "shutdown")
                {
                    Send(Response(id, true, new Dictionary<string, object> { { "bye", true } }, null));
                    _shuttingDown = true;
                }
                else
                {
                    Send(Response(id, false, null, Error("INVALID_ARGUMENT", "Unknown command: " + cmd)));
                }
            }
            catch (HelperException hex)
            {
                Log("warn", "command " + cmd + " rejected: " + hex.Code + " " + hex.Message);
                Send(Response(id, false, null, Error(hex.Code, hex.Message)));
            }
            catch (Exception ex)
            {
                Log("error", "command " + cmd + " failed: " + ex.Message);
                Send(Response(id, false, null, Error("INTERNAL", ex.Message)));
            }
        }

        private Dictionary<string, object> StatusData()
        {
            var status = BuildStatus();
            status["parentPid"] = _parentPid;
            status["execution"] = ExecutionData();
            status["lidApplied"] = _lidApplied;
            status["recoveryPending"] = !string.IsNullOrEmpty(_recoveryPath) && File.Exists(_recoveryPath) && !_lidApplied;
            if (_lidApplied)
            {
                status["originalAc"] = _originalAc;
                status["originalDc"] = _originalDc;
                status["appliedScheme"] = _appliedScheme.ToString();
            }
            return status;
        }

        private Dictionary<string, object> ExecutionData()
        {
            lock (_execLock)
            {
                return new Dictionary<string, object> {
                    { "active", _execSystem || _execDisplay },
                    { "system", _execSystem },
                    { "display", _execDisplay }
                };
            }
        }

        private Dictionary<string, object> LidData()
        {
            var data = new Dictionary<string, object>();
            data["applied"] = _lidApplied;
            if (_lidApplied)
            {
                data["scheme"] = _appliedScheme.ToString();
                data["originalAc"] = _originalAc;
                data["originalDc"] = _originalDc;
            }
            Guid scheme;
            uint ac, dc, rcAc, rcDc;
            bool read = PowerApi.TryReadLid(out scheme, out ac, out dc, out rcAc, out rcDc);
            data["readable"] = read;
            data["scheme"] = read ? scheme.ToString() : null;
            data["ac"] = read ? (object)ac : null;
            data["dc"] = read ? (object)dc : null;
            data["elevated"] = IsElevated();
            return data;
        }

        private bool ApplyLid(out string code, out string message)
        {
            code = null;
            message = null;
            lock (_lidLock)
            {
                if (!IsElevated())
                {
                    code = "ELEVATION_REQUIRED";
                    message = "Administrator approval is required to change the lid power policy.";
                    return false;
                }

                if (_lidApplied)
                {
                    Guid current;
                    uint ac, dc, rcAc, rcDc;
                    if (PowerApi.TryReadLid(out current, out ac, out dc, out rcAc, out rcDc)
                        && current == _appliedScheme && ac == 0 && dc == 0)
                    {
                        return true;
                    }
                    if (PowerApi.TryReadLid(out current, out ac, out dc, out rcAc, out rcDc)
                        && current == _appliedScheme && (ac != 0 || dc != 0))
                    {
                        uint rewriteError;
                        if (PowerApi.TryWriteLid(_appliedScheme, 0, 0, out rewriteError))
                        {
                            Log("info", "re-applied lid policy without restoring backup");
                            return true;
                        }
                    }
                    string restoreCode, restoreMessage;
                    if (!RestoreLidLocked(out restoreCode, out restoreMessage))
                    {
                        code = restoreCode;
                        message = "Could not restore the previous lid policy before reapplying: " + restoreMessage;
                        return false;
                    }
                }
                else if (!string.IsNullOrEmpty(_recoveryPath) && File.Exists(_recoveryPath))
                {
                    string recoverCode, recoverMessage;
                    if (!RecoverFromFileLocked(out recoverCode, out recoverMessage))
                    {
                        code = recoverCode;
                        message = "Could not clear the previous lid policy backup: " + recoverMessage;
                        return false;
                    }
                }

                Guid scheme;
                uint origAc, origDc, readAcError, readDcError;
                if (!PowerApi.TryReadLid(out scheme, out origAc, out origDc, out readAcError, out readDcError))
                {
                    code = "LID_UNSUPPORTED";
                    message = "The lid action setting could not be read (rc " + readAcError + "/" + readDcError + ").";
                    return false;
                }

                // Persist the original values *before* touching the policy. A crash
                // between the write and a later backup would otherwise leave the PC
                // with "do nothing on lid close" and no way to detect it next launch.
                try
                {
                    WriteRecovery(scheme, origAc, origDc);
                }
                catch (Exception ex)
                {
                    code = "RECOVERY_FAILED";
                    message = "Could not back up the current lid policy before changing it: " + ex.Message;
                    return false;
                }

                uint writeError;
                if (!PowerApi.TryWriteLid(scheme, 0, 0, out writeError))
                {
                    Log("warn", "Power API write failed rc=" + writeError + "; trying powercfg fallback");
                    bool fallback = RunPowerCfg(scheme, 0, 0);
                    if (!fallback)
                    {
                        RestoreAfterFailedApply(scheme, origAc, origDc);
                        code = "LID_WRITE_FAILED";
                        message = "Windows refused the lid policy change (rc " + writeError + ").";
                        return false;
                    }
                }

                uint verifyAc, verifyDc, verifyRcAc, verifyRcDc;
                Guid verifyScheme;
                if (!PowerApi.TryReadLid(out verifyScheme, out verifyAc, out verifyDc, out verifyRcAc, out verifyRcDc)
                    || verifyAc != 0 || verifyDc != 0)
                {
                    RestoreAfterFailedApply(scheme, origAc, origDc);
                    code = "LID_WRITE_FAILED";
                    message = "The lid policy did not verify after writing (ac " + verifyAc + ", dc " + verifyDc + ").";
                    return false;
                }

                _lidApplied = true;
                _appliedScheme = scheme;
                _originalAc = origAc;
                _originalDc = origDc;
                Log("info", "lid applied; scheme=" + scheme + " original=" + origAc + "/" + origDc);
                return true;
            }
        }

        /// <summary>
        /// Best-effort rollback after a failed apply. The recovery file written
        /// before the write is only removed once the original values are back, so
        /// a failed rollback still leaves a detectable state for the next launch.
        /// </summary>
        private void RestoreAfterFailedApply(Guid scheme, uint ac, uint dc)
        {
            uint restoreError;
            bool restored = PowerApi.TryWriteLid(scheme, ac, dc, out restoreError);
            if (!restored) restored = RunPowerCfg(scheme, ac, dc);
            if (restored)
            {
                DeleteRecovery();
                Log("info", "restored the original lid policy after a failed apply");
            }
            else
            {
                Log("warn", "could not restore the original lid policy; recovery file kept");
            }
        }

        private bool RestoreLid(out string code, out string message)
        {
            lock (_lidLock)
            {
                return RestoreLidLocked(out code, out message);
            }
        }

        private bool RestoreLidLocked(out string code, out string message)
        {
            code = null;
            message = null;
            if (!_lidApplied)
            {
                if (!string.IsNullOrEmpty(_recoveryPath) && File.Exists(_recoveryPath))
                {
                    return RecoverFromFileLocked(out code, out message);
                }
                return true;
            }
            if (!IsElevated())
            {
                code = "ELEVATION_REQUIRED";
                message = "Administrator approval is required to restore the lid policy.";
                return false;
            }

            uint writeError;
            bool ok = PowerApi.TryWriteLid(_appliedScheme, _originalAc, _originalDc, out writeError);
            if (!ok)
            {
                Log("warn", "Power API restore failed rc=" + writeError + "; trying powercfg fallback");
                ok = RunPowerCfg(_appliedScheme, _originalAc, _originalDc);
            }
            if (!ok)
            {
                code = "RESTORE_FAILED";
                message = "Could not restore the lid policy (rc " + writeError + ").";
                return false;
            }

            Guid current;
            uint ac, dc, rcAc, rcDc;
            if (!PowerApi.TryReadLid(out current, out ac, out dc, out rcAc, out rcDc)
                || current != _appliedScheme || ac != _originalAc || dc != _originalDc)
            {
                code = "RESTORE_FAILED";
                message = "The restored lid policy did not verify.";
                return false;
            }

            _lidApplied = false;
            DeleteRecovery();
            Log("info", "lid restored; scheme=" + _appliedScheme + " values=" + _originalAc + "/" + _originalDc);
            return true;
        }

        private bool RecoverFromFile(out string code, out string message)
        {
            lock (_lidLock)
            {
                return RecoverFromFileLocked(out code, out message);
            }
        }

        private bool RecoverFromFileLocked(out string code, out string message)
        {
            code = null;
            message = null;
            if (string.IsNullOrEmpty(_recoveryPath) || !File.Exists(_recoveryPath))
            {
                code = "RECOVERY_NONE";
                message = "No previous lid policy backup was found.";
                return false;
            }
            if (!IsElevated())
            {
                code = "ELEVATION_REQUIRED";
                message = "Administrator approval is required to restore the previous lid policy.";
                return false;
            }
            try
            {
                var record = Json.Deserialize<RecoveryRecord>(File.ReadAllText(_recoveryPath));
                if (record == null)
                {
                    code = "RECOVERY_FAILED";
                    message = "The recovery file is empty or invalid.";
                    return false;
                }
                Guid scheme = new Guid(record.scheme);
                uint writeError;
                bool ok = PowerApi.TryWriteLid(scheme, record.ac, record.dc, out writeError);
                if (!ok)
                {
                    ok = RunPowerCfg(scheme, record.ac, record.dc);
                }
                if (!ok)
                {
                    code = "RECOVERY_FAILED";
                    message = "Could not restore the previous lid policy (rc " + writeError + ").";
                    return false;
                }
                _lidApplied = false;
                DeleteRecovery();
                Log("info", "recovered previous lid policy from file; scheme=" + scheme);
                return true;
            }
            catch (Exception ex)
            {
                code = "RECOVERY_FAILED";
                message = "Could not read the recovery file: " + ex.Message;
                return false;
            }
        }

        private void WriteRecovery(Guid scheme, uint ac, uint dc)
        {
            if (string.IsNullOrEmpty(_recoveryPath)) return;
            var record = new RecoveryRecord {
                version = Version,
                scheme = scheme.ToString(),
                ac = ac,
                dc = dc,
                appliedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                pid = Process.GetCurrentProcess().Id
            };
            WriteAllTextAtomic(_recoveryPath, Json.Serialize(record));
        }

        private void DeleteRecovery()
        {
            try
            {
                if (!string.IsNullOrEmpty(_recoveryPath) && File.Exists(_recoveryPath)) File.Delete(_recoveryPath);
            }
            catch (Exception ex)
            {
                Log("warn", "could not delete recovery file: " + ex.Message);
            }
        }

        private bool RunPowerCfg(Guid scheme, uint ac, uint dc)
        {
            try
            {
                string acResult = RunProcess("powercfg.exe", "/setacvalueindex " + scheme + " " + SUB_BUTTONS + " " + LID_ACTION + " " + ac);
                string dcResult = RunProcess("powercfg.exe", "/setdcvalueindex " + scheme + " " + SUB_BUTTONS + " " + LID_ACTION + " " + dc);
                string active = RunProcess("powercfg.exe", "/setactive " + scheme);
                Log("info", "powercfg fallback ac=" + acResult + " dc=" + dcResult + " active=" + active);
                return string.IsNullOrEmpty(acResult) && string.IsNullOrEmpty(dcResult) && string.IsNullOrEmpty(active);
            }
            catch (Exception ex)
            {
                Log("warn", "powercfg fallback failed: " + ex.Message);
                return false;
            }
        }

        private static string RunProcess(string file, string arguments)
        {
            var info = new ProcessStartInfo(file, arguments);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardError = true;
            info.RedirectStandardOutput = true;
            using (Process process = Process.Start(info))
            {
                string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                process.WaitForExit(10000);
                if (!process.HasExited)
                {
                    try { process.Kill(); } catch { }
                    return "timeout";
                }
                return process.ExitCode == 0 ? string.Empty : output.Trim();
            }
        }

        private void StartExecutionThread()
        {
            _execThread = new Thread(ExecutionLoop);
            _execThread.IsBackground = true;
            _execThread.Name = "InsomniaZExecutionState";
            _execThread.Start();
        }

        private void ExecutionLoop()
        {
            while (!_shuttingDown)
            {
                ApplyExecutionState();
                Thread.Sleep(15000);
            }
            try { SetThreadExecutionState(ES_CONTINUOUS); } catch { }
        }

        private void ApplyExecutionState()
        {
            uint flags = ES_CONTINUOUS;
            if (_execSystem) flags |= ES_SYSTEM_REQUIRED;
            if (_execDisplay) flags |= ES_DISPLAY_REQUIRED;
            try { SetThreadExecutionState(flags); } catch { }
        }

        private void StartParentWatch()
        {
            _parentThread = new Thread(ParentLoop);
            _parentThread.IsBackground = true;
            _parentThread.Name = "InsomniaZParentWatch";
            _parentThread.Start();
        }

        private void ParentLoop()
        {
            while (!_shuttingDown)
            {
                Thread.Sleep(2000);
                try
                {
                    Process parent = Process.GetProcessById(_parentPid);
                    if (parent.HasExited)
                    {
                        Log("info", "parent exited; shutting down");
                        _shuttingDown = true;
                        return;
                    }
                }
                catch
                {
                    Log("info", "parent not found; shutting down");
                    _shuttingDown = true;
                    return;
                }
            }
        }

        private void StartLidWatch()
        {
            _lidThread = new Thread(LidLoop);
            _lidThread.IsBackground = true;
            _lidThread.Name = "InsomniaZLidWatch";
            _lidThread.Start();
        }

        private void LidLoop()
        {
            while (!_shuttingDown)
            {
                Thread.Sleep(10000);
                if (!_lidApplied || _shuttingDown) continue;
                try
                {
                    lock (_lidLock)
                    {
                        if (!_lidApplied) continue;
                        Guid scheme;
                        uint ac, dc, rcAc, rcDc;
                        bool read = PowerApi.TryReadLid(out scheme, out ac, out dc, out rcAc, out rcDc);
                        if (read && scheme == _appliedScheme && (ac != 0 || dc != 0))
                        {
                            Log("warn", "lid policy changed externally; reapplying");
                            uint writeError;
                            PowerApi.TryWriteLid(_appliedScheme, 0, 0, out writeError);
                        }
                        else if (read && scheme != _appliedScheme)
                        {
                            Log("warn", "power scheme changed while lid protection is active");
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log("warn", "lid watch failed: " + ex.Message);
                }
            }
        }

        private void OnProcessExit(object sender, EventArgs e)
        {
            Cleanup();
        }

        private void OnSessionEnding(object sender, Microsoft.Win32.SessionEndingEventArgs e)
        {
            Log("info", "Windows session ending; restoring lid policy");
            Cleanup();
        }

        private void Cleanup()
        {
            if (Interlocked.Exchange(ref _cleanupStarted, 1) == 1) return;
            _shuttingDown = true;
            lock (_lidLock)
            {
                if (_lidApplied)
                {
                    string code, message;
                    RestoreLidLocked(out code, out message);
                    if (!string.IsNullOrEmpty(code)) Log("error", "cleanup restore failed: " + code + " " + message);
                }
            }
            try { SetThreadExecutionState(ES_CONTINUOUS); } catch { }
            try { if (_writer != null) _writer.Flush(); } catch { }
            try { if (_pipe != null) _pipe.Dispose(); } catch { }
            Log("info", "helper stopped");
        }

        private void Send(Dictionary<string, object> message)
        {
            try
            {
                string line = Json.Serialize(message);
                lock (_writeLock)
                {
                    if (_writer != null)
                    {
                        _writer.WriteLine(line);
                        _writer.Flush();
                    }
                }
            }
            catch (Exception ex)
            {
                Log("warn", "could not send response: " + ex.Message);
            }
        }
    }

    private sealed class HelperException : Exception
    {
        public readonly string Code;

        public HelperException(string code, string message) : base(message)
        {
            Code = code;
        }
    }

    /// <summary>
    /// UI Automation and the MSAA bridge must run on an STA thread; on an MTA
    /// thread the proxies expose only the window chrome.
    /// </summary>
    internal static class UiaDispatcher
    {
        private sealed class WorkItem
        {
            public Func<object> Work;
            public object Result;
            public Exception Error;
            public ManualResetEventSlim Done;
        }

        private static readonly BlockingCollection<WorkItem> Queue = new BlockingCollection<WorkItem>();
        private static readonly object StartLock = new object();
        private static Thread _thread;

        public static T Run<T>(Func<T> work, int timeoutMs)
        {
            if (Thread.CurrentThread.GetApartmentState() == ApartmentState.STA) return work();
            EnsureThread();
            var item = new WorkItem();
            item.Work = delegate { return work(); };
            item.Done = new ManualResetEventSlim(false);
            Queue.Add(item);
            if (!item.Done.Wait(timeoutMs))
            {
                throw new HelperException("UIA_TIMEOUT", "The UI Automation worker did not respond in time.");
            }
            if (item.Error != null)
            {
                HelperException known = item.Error as HelperException;
                if (known != null) throw known;
                throw new HelperException("UIA_FAILED", item.Error.Message);
            }
            return (T)item.Result;
        }

        private static void EnsureThread()
        {
            if (_thread != null) return;
            lock (StartLock)
            {
                if (_thread != null) return;
                var thread = new Thread(Loop);
                thread.IsBackground = true;
                thread.SetApartmentState(ApartmentState.STA);
                thread.Name = "InsomniaZUia";
                thread.Start();
                _thread = thread;
            }
        }

        private static void Loop()
        {
            try { CoInitializeEx(IntPtr.Zero, 0x2); } catch { }
            foreach (WorkItem item in Queue.GetConsumingEnumerable())
            {
                try { item.Result = item.Work(); }
                catch (Exception ex) { item.Error = ex; }
                finally { item.Done.Set(); }
            }
        }
    }

    private sealed class WindowEntry
    {
        public IntPtr Hwnd;
        public int Pid;
        public string Process;
        public string Title;
        public string ClassName;
        public IntRect Rect;
        public bool Foreground;
    }

    private sealed class CachedElement
    {
        public AutomationElement Element;
        public DateTime At;
        public string WindowRef;
    }

    private sealed class IntRect
    {
        public int X;
        public int Y;
        public int W;
        public int H;

        public Dictionary<string, object> ToJson()
        {
            return new Dictionary<string, object> {
                { "x", X }, { "y", Y }, { "w", W }, { "h", H }
            };
        }
    }

    /// <summary>
    /// Read-only UI Automation metadata scan plus the narrow set of actions the
    /// GUI fallback needs. Element values are never read; only names, ids and
    /// rectangles leave the helper, so no typed text is captured.
    /// </summary>
    internal static class GuiAutomation
    {
        private const int MaxNameLength = 200;
        private const int MaxAnchorLength = 160;
        private static readonly object RefLock = new object();
        private static readonly Dictionary<string, CachedElement> Refs = new Dictionary<string, CachedElement>();
        private static readonly TimeSpan RefTtl = TimeSpan.FromMinutes(3);
        private static int _refSeq;

        private static readonly string[] InterestingTypes = new string[] {
            "Edit", "Document", "Button", "Hyperlink", "ListItem", "TabItem", "TreeItem", "MenuItem"
        };

        private const int RoleText = 0x2A;
        private const int RolePushButton = 0x2B;
        private const int RoleLink = 0x1E;
        private const int RoleListItem = 0x22;
        private const int RolePageTab = 0x25;
        private const int RoleComboBox = 0x2E;
        private const int RoleOutlineItem = 0x24;
        private const int RoleMenuItem = 0x0C;
        private const int RoleDocument = 0x0F;
        private const int RoleButtonDropDown = 0x38;

        public static Dictionary<string, object> Scan(Dictionary<string, object> args)
        {
            return UiaDispatcher.Run<Dictionary<string, object>>(delegate { return ScanCore(args); }, 90000);
        }

        private static Dictionary<string, object> ScanCore(Dictionary<string, object> args)
        {
            string processFilter = NormalizeProcess(GetString(args, "processName"));
            string titleFilter = GetString(args, "windowTitle");
            int maxWindows = Clamp(GetInt(args, "maxWindows", 6), 1, 10);
            int maxElements = Clamp(GetInt(args, "maxElements", 220), 20, 600);

            List<WindowEntry> all = EnumerateWindows(titleFilter, processFilter);
            all.Sort(delegate(WindowEntry a, WindowEntry b)
            {
                if (a.Foreground != b.Foreground) return a.Foreground ? -1 : 1;
                int areaA = a.Rect.W * a.Rect.H;
                int areaB = b.Rect.W * b.Rect.H;
                if (areaA != areaB) return areaB.CompareTo(areaA);
                return string.Compare(a.Title, b.Title, StringComparison.OrdinalIgnoreCase);
            });
            if (all.Count > maxWindows) all.RemoveRange(maxWindows, all.Count - maxWindows);

            lock (RefLock)
            {
                Refs.Clear();
                _refSeq = 0;
            }

            var windows = new List<object>();
            int index = 0;
            foreach (WindowEntry window in all)
            {
                index++;
                string windowRef = "w" + index;
                Dictionary<string, object> entry = WindowDictionary(window);
                entry["ref"] = windowRef;
                var candidates = new List<object>();
                var counts = new Dictionary<string, object> {
                    { "edits", 0 }, { "documents", 0 }, { "buttons", 0 },
                    { "listItems", 0 }, { "tabItems", 0 }, { "hyperlinks", 0 },
                    { "editable", 0 }
                };
                try
                {
                    AutomationElement windowElement = AutomationElement.FromHandle(window.Hwnd);
                    CollectCandidates(windowElement, window, windowRef, maxElements, candidates, counts);
                    // Chromium/Electron enables its accessibility tree lazily, so the
                    // first read after launch can come back empty.
                    for (int retry = 0; retry < 2 && candidates.Count == 0; retry++)
                    {
                        Thread.Sleep(280);
                        CollectCandidates(windowElement, window, windowRef, maxElements, candidates, counts);
                    }
                }
                catch (Exception ex)
                {
                    entry["error"] = ex.Message;
                }
                entry["candidates"] = candidates;
                entry["candidateCount"] = candidates.Count;
                entry["counts"] = counts;
                windows.Add(entry);
            }

            var result = new Dictionary<string, object>();
            result["scannedAt"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            result["windowCount"] = windows.Count;
            result["windows"] = windows;
            return result;
        }

        public static Dictionary<string, object> Act(Dictionary<string, object> args)
        {
            return UiaDispatcher.Run<Dictionary<string, object>>(delegate { return ActCore(args); }, 90000);
        }

        private static Dictionary<string, object> ActCore(Dictionary<string, object> args)
        {
            string action = (GetString(args, "action") ?? string.Empty).Trim().ToLowerInvariant();
            string refId = GetString(args, "ref");
            string windowRef = GetString(args, "window");
            long hwndValue = GetLong(args, "hwnd", 0);
            if (action.Length == 0) throw new HelperException("INVALID_ARGUMENT", "action is required.");
            if (string.IsNullOrEmpty(refId)) throw new HelperException("INVALID_ARGUMENT", "ref is required.");

            CachedElement cached;
            lock (RefLock)
            {
                Refs.TryGetValue(refId, out cached);
                if (cached != null && DateTime.UtcNow - cached.At > RefTtl)
                {
                    Refs.Remove(refId);
                    cached = null;
                }
            }
            if (cached == null) throw new HelperException("STALE_ELEMENT", "The element reference is no longer available; scan again.");
            if (!string.IsNullOrEmpty(windowRef) && cached.WindowRef != windowRef)
            {
                throw new HelperException("ELEMENT_WINDOW_MISMATCH", "The element does not belong to the requested window.");
            }

            AutomationElement element = cached.Element;
            System.Windows.Rect bounds;
            try { bounds = element.Current.BoundingRectangle; }
            catch (Exception ex) { throw new HelperException("STALE_ELEMENT", "The element disappeared: " + ex.Message); }
            if (bounds.IsEmpty || bounds.Width < 2 || bounds.Height < 2)
            {
                throw new HelperException("ELEMENT_NOT_VISIBLE", "The element has no usable bounds.");
            }

            IntPtr hwnd = hwndValue > 0 ? new IntPtr(hwndValue) : IntPtr.Zero;
            if (hwnd == IntPtr.Zero)
            {
                POINT center;
                center.x = (int)Math.Round(bounds.Left + bounds.Width / 2.0);
                center.y = (int)Math.Round(bounds.Top + bounds.Height / 2.0);
                hwnd = GetAncestor(WindowFromPoint(center), 2);
            }
            if (hwnd == IntPtr.Zero) throw new HelperException("WINDOW_NOT_FOUND", "Could not resolve the target window.");

            IntRect windowRect;
            if (!TryGetWindowRect(hwnd, out windowRect))
            {
                throw new HelperException("WINDOW_NOT_FOUND", "The target window no longer exists.");
            }
            int centerX = (int)Math.Round(bounds.Left + bounds.Width / 2.0);
            int centerY = (int)Math.Round(bounds.Top + bounds.Height / 2.0);
            if (centerX < windowRect.X || centerY < windowRect.Y
                || centerX > windowRect.X + windowRect.W || centerY > windowRect.Y + windowRect.H)
            {
                throw new HelperException("ELEMENT_OUTSIDE_WINDOW", "The element is no longer inside the target window.");
            }

            var result = new Dictionary<string, object>();
            result["action"] = action;
            result["ref"] = refId;
            result["hwnd"] = hwnd.ToInt64();

            switch (action)
            {
                case "focus":
                    BringToForeground(hwnd);
                    element.SetFocus();
                    result["method"] = "focus";
                    break;
                case "setvalue":
                    result["method"] = SetElementText(element, hwnd, GetString(args, "text") ?? string.Empty);
                    result["length"] = (GetString(args, "text") ?? string.Empty).Length;
                    break;
                case "invoke":
                    BringToForeground(hwnd);
                    result["method"] = InvokeElement(element, hwnd);
                    break;
                case "click":
                    BringToForeground(hwnd);
                    ClickElement(element, hwnd);
                    result["method"] = "click";
                    break;
                case "select":
                    BringToForeground(hwnd);
                    result["method"] = SelectElement(element, hwnd);
                    break;
                default:
                    throw new HelperException("INVALID_ARGUMENT", "Unsupported action: " + action);
            }
            return result;
        }

        private static string SetElementText(AutomationElement element, IntPtr hwnd, string text)
        {
            BringToForeground(hwnd);
            object pattern;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            {
                var value = (ValuePattern)pattern;
                if (value.Current.IsReadOnly) throw new HelperException("ELEMENT_READ_ONLY", "The input element is read-only.");
                value.SetValue(text);
                return "value";
            }
            try { element.SetFocus(); } catch { }
            Thread.Sleep(80);
            ClickElement(element, hwnd);
            Thread.Sleep(120);
            if (GetForegroundWindow() != hwnd)
            {
                throw new HelperException("WINDOW_NOT_FOREGROUND", "The target window lost focus before text could be entered.");
            }
            SendVirtualKey(0x11, false); // Ctrl down
            SendVirtualKey(0x41, false); // A
            SendVirtualKey(0x41, true);
            SendVirtualKey(0x11, true);
            SendVirtualKey(0x2E, false); // Delete existing draft
            SendVirtualKey(0x2E, true);
            Thread.Sleep(40);
            // Enter would submit the chat message early, so newlines become spaces.
            string payload = text.Replace("\r", " ").Replace("\n", " ");
            SendUnicodeText(payload);
            // Give the UI thread time to drain the WM_CHAR queue; a following
            // UIA invoke can otherwise overtake the last keystrokes.
            Thread.Sleep(120);
            for (int attempt = 0; attempt < 6; attempt++)
            {
                string current = ReadElementText(element);
                if (current != null && (current == payload || current.EndsWith(Tail(payload, 16))))
                {
                    return "type";
                }
                Thread.Sleep(80);
            }
            return "type";
        }

        private static string Tail(string value, int max)
        {
            return value.Length <= max ? value : value.Substring(value.Length - max);
        }

        private static string ReadElementText(AutomationElement element)
        {
            try
            {
                object pattern;
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                {
                    return ((ValuePattern)pattern).Current.Value;
                }
                if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                {
                    return ((TextPattern)pattern).DocumentRange.GetText(-1);
                }
            }
            catch
            {
                // Reading is best effort; typing already happened.
            }
            return null;
        }

        private static string InvokeElement(AutomationElement element, IntPtr hwnd)
        {
            object pattern;
            if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
            {
                try
                {
                    ((InvokePattern)pattern).Invoke();
                    return "invoke";
                }
                catch (Exception ex)
                {
                    Log("warn", "InvokePattern failed; falling back to a click: " + ex.Message);
                }
            }
            ClickElement(element, hwnd);
            return "click";
        }

        private static string SelectElement(AutomationElement element, IntPtr hwnd)
        {
            object pattern;
            if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
            {
                try
                {
                    ((SelectionItemPattern)pattern).Select();
                    return "select";
                }
                catch (Exception ex)
                {
                    Log("warn", "SelectionItemPattern failed; falling back to a click: " + ex.Message);
                }
            }
            ClickElement(element, hwnd);
            return "click";
        }

        private static void ClickElement(AutomationElement element, IntPtr hwnd)
        {
            System.Windows.Rect bounds = element.Current.BoundingRectangle;
            if (bounds.IsEmpty || bounds.Width < 2 || bounds.Height < 2)
            {
                throw new HelperException("ELEMENT_NOT_VISIBLE", "The element has no usable bounds.");
            }
            if (GetForegroundWindow() != hwnd)
            {
                throw new HelperException("WINDOW_NOT_FOREGROUND", "Refusing to click while the target window is not in front.");
            }
            int x = (int)Math.Round(bounds.Left + bounds.Width / 2.0);
            int y = (int)Math.Round(bounds.Top + bounds.Height / 2.0);
            POINT previous;
            bool hadCursor = GetCursorPos(out previous);
            if (!SetCursorPos(x, y)) throw new HelperException("CLICK_FAILED", "Could not move the pointer.");
            Thread.Sleep(30);
            SendMouse(0x0002);
            SendMouse(0x0004);
            Thread.Sleep(70);
            if (hadCursor) SetCursorPos(previous.x, previous.y);
        }

        private static void BringToForeground(IntPtr hwnd)
        {
            if (GetForegroundWindow() == hwnd) return;
            if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
            uint ignored;
            uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
            uint currentThread = GetCurrentThreadId();
            bool attached = false;
            if (foregroundThread != 0 && foregroundThread != currentThread)
            {
                attached = AttachThreadInput(currentThread, foregroundThread, true);
            }
            try
            {
                SetForegroundWindow(hwnd);
            }
            finally
            {
                if (attached) AttachThreadInput(currentThread, foregroundThread, false);
            }
            Thread.Sleep(180);
            if (GetForegroundWindow() != hwnd)
            {
                throw new HelperException("WINDOW_NOT_FOREGROUND", "Windows refused to bring the target window to the front.");
            }
        }

        private static void CollectCandidates(AutomationElement windowElement, WindowEntry window, string windowRef,
            int maxElements, List<object> output, Dictionary<string, object> counts)
        {
            var typeCondition = new OrCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Hyperlink),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Group),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Pane));
            var condition = new AndCondition(typeCondition,
                new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
            AutomationElementCollection found = windowElement.FindAll(TreeScope.Descendants, condition);
            int scanned = 0;
            Stopwatch clock = Stopwatch.StartNew();
            foreach (AutomationElement element in found)
            {
                if (output.Count >= maxElements || scanned >= maxElements * 6 || clock.ElapsedMilliseconds > 6000) break;
                scanned++;
                try
                {
                    AutomationElement.AutomationElementInformation current = element.Current;
                    string typeName = ControlTypeName(current.ControlType);
                    Log("info", "uia elem type=" + typeName);
                    System.Windows.Rect bounds = current.BoundingRectangle;
                    if (bounds.IsEmpty || bounds.Width < 4 || bounds.Height < 4) continue;
                    int centerX = (int)Math.Round(bounds.Left + bounds.Width / 2.0);
                    int centerY = (int)Math.Round(bounds.Top + bounds.Height / 2.0);
                    if (centerX < window.Rect.X || centerY < window.Rect.Y
                        || centerX > window.Rect.X + window.Rect.W || centerY > window.Rect.Y + window.Rect.H)
                    {
                        continue;
                    }

                    string name = SafeText(current.Name, MaxNameLength);
                    string automationId = SafeText(current.AutomationId, MaxAnchorLength);
                    string className = SafeText(current.ClassName, MaxAnchorLength);
                    bool container = typeName == "Pane" || typeName == "Text" || typeName == "Custom"
                        || typeName == "Group";

                    bool editable = false;
                    bool invokable = false;
                    bool selectable = false;
                    bool selected = false;
                    bool expandable = false;
                    object pattern;
                    if (typeName == "Edit" || typeName == "Document")
                    {
                        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                        {
                            try { editable = !((ValuePattern)pattern).Current.IsReadOnly; } catch { }
                        }
                        else
                        {
                            // Rich editors expose a focusable Document without
                            // ValuePattern; SetElementText can still type into it.
                            try { editable = current.IsEnabled && current.IsKeyboardFocusable; } catch { }
                        }
                    }
                    if (typeName == "Group" || typeName == "Pane" || typeName == "Custom")
                    {
                        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                        {
                            try { if (!((ValuePattern)pattern).Current.IsReadOnly) editable = true; } catch { }
                        }
                        // ProseMirror/TipTap/Monaco-style editors surface as a
                        // focusable Group with no ValuePattern at all.
                        if (!editable && IsEditorSurface(className, automationId))
                        {
                            try { editable = current.IsEnabled && current.IsKeyboardFocusable; } catch { }
                        }
                    }
                    if (typeName == "Button" && element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) invokable = true;
                    if (typeName == "Button" && element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) expandable = true;
                    if ((typeName == "ListItem" || typeName == "TabItem")
                        && element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
                    {
                        selectable = true;
                        try { selected = ((SelectionItemPattern)pattern).Current.IsSelected; } catch { }
                    }

                    int legacyRole = -1;
                    if (container)
                    {
                        legacyRole = LegacyRole(element);
                        if (legacyRole == RoleText) editable = true;
                        if (legacyRole == RoleDocument) editable = true;
                        if (legacyRole == RolePushButton || legacyRole == RoleButtonDropDown) expandable = expandable || legacyRole == RoleButtonDropDown;
                        if (legacyRole == RoleListItem || legacyRole == RolePageTab || legacyRole == RoleOutlineItem) selectable = true;
                        bool useful = editable || invokable || legacyRole == RolePushButton || legacyRole == RoleLink
                            || legacyRole == RoleMenuItem || legacyRole == RoleListItem || legacyRole == RolePageTab
                            || legacyRole == RoleComboBox || legacyRole == RoleOutlineItem || legacyRole == RoleButtonDropDown;
                        if (!useful) continue;
                    }
                    if (name.Length == 0 && automationId.Length == 0 && typeName != "Edit"
                        && typeName != "Document" && !editable) continue;

                    string refId;
                    lock (RefLock)
                    {
                        _refSeq++;
                        refId = "e" + _refSeq;
                        Refs[refId] = new CachedElement { Element = element, At = DateTime.UtcNow, WindowRef = windowRef };
                    }

                    var item = new Dictionary<string, object> {
                        { "ref", refId },
                        { "name", name },
                        { "automationId", automationId },
                        { "className", className },
                        { "controlType", typeName },
                        { "rect", RectDictionary(bounds) },
                        { "enabled", current.IsEnabled },
                        { "keyboardFocusable", current.IsKeyboardFocusable },
                        { "editable", editable },
                        { "invokable", invokable },
                        { "selectable", selectable },
                        { "selected", selected },
                        { "expandable", expandable }
                    };
                    if (legacyRole >= 0) item["legacyRole"] = legacyRole;
                    output.Add(item);
                    Increment(counts, typeName, editable);
                }
                catch
                {
                    // Elements can vanish mid-scan; skip them.
                }
            }
            Log("info", "uia scan window done candidates=" + output.Count + " scanned=" + scanned);
        }

        private static bool IsEditorSurface(string className, string automationId)
        {
            string haystack = (className + " " + automationId).ToLowerInvariant();
            return haystack.Contains("prosemirror") || haystack.Contains("tiptap")
                || haystack.Contains("codemirror") || haystack.Contains("monaco")
                || haystack.Contains("contenteditable") || haystack.Contains("rich-text")
                || haystack.Contains("rich_text") || haystack.Contains("lexical")
                || haystack.Contains("slate-editor") || haystack.Contains("chat-input")
                || haystack.Contains("chat_input") || haystack.Contains("composer");
        }

        private static int LegacyRole(AutomationElement element)
        {
            try
            {
                System.Windows.Rect rect = element.Current.BoundingRectangle;
                if (rect.IsEmpty || rect.Width < 2 || rect.Height < 2) return -1;
                int x = (int)Math.Round(rect.Left + rect.Width / 2.0);
                int y = (int)Math.Round(rect.Top + rect.Height / 2.0);
                return MsaaRoleAt(x, y);
            }
            catch
            {
                return -1;
            }
        }

        private static int MsaaRoleAt(int x, int y)
        {
            Accessibility.IAccessible accessible = null;
            try
            {
                POINT point;
                point.x = x;
                point.y = y;
                object child = 0;
                int hr = AccessibleObjectFromPoint(point, out accessible, ref child);
                if (hr != 0 || accessible == null) return -1;
                object role = accessible.get_accRole(child);
                if (role == null) return -1;
                return Convert.ToInt32(role, CultureInfo.InvariantCulture);
            }
            catch
            {
                return -1;
            }
            finally
            {
                try { if (accessible != null) Marshal.ReleaseComObject(accessible); } catch { }
            }
        }

        private static void Increment(Dictionary<string, object> counts, string typeName, bool editable)
        {
            string key = null;
            if (typeName == "Edit") key = "edits";
            else if (typeName == "Document") key = "documents";
            else if (typeName == "Button") key = "buttons";
            else if (typeName == "ListItem") key = "listItems";
            else if (typeName == "TabItem") key = "tabItems";
            else if (typeName == "Hyperlink") key = "hyperlinks";
            if (key == null) return;
            counts[key] = Convert.ToInt32(counts[key], CultureInfo.InvariantCulture) + 1;
            if (editable) counts["editable"] = Convert.ToInt32(counts["editable"], CultureInfo.InvariantCulture) + 1;
        }

        private static List<WindowEntry> EnumerateWindows(string titleFilter, string processFilter)
        {
            var result = new List<WindowEntry>();
            int ownPid = Process.GetCurrentProcess().Id;
            EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
            {
                try
                {
                    if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
                    int cloaked;
                    if (DwmGetWindowAttribute(hwnd, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
                    int length = GetWindowTextLength(hwnd);
                    if (length <= 0) return true;
                    var buffer = new StringBuilder(length + 2);
                    GetWindowText(hwnd, buffer, buffer.Capacity);
                    string title = buffer.ToString().Trim();
                    if (title.Length == 0) return true;
                    if (!string.IsNullOrEmpty(titleFilter)
                        && title.IndexOf(titleFilter, StringComparison.OrdinalIgnoreCase) < 0) return true;
                    IntRect rect;
                    if (!TryGetWindowRect(hwnd, out rect) || rect.W < 160 || rect.H < 100) return true;
                    string windowClass = WindowClass(hwnd);
                    if (string.Equals(windowClass, "Progman", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(windowClass, "WorkerW", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(windowClass, "Shell_TrayWnd", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(windowClass, "Shell_SecondaryTrayWnd", StringComparison.OrdinalIgnoreCase)) return true;
                    uint pid;
                    GetWindowThreadProcessId(hwnd, out pid);
                    if (pid == 0 || (int)pid == ownPid) return true;
                    string process = ProcessName((int)pid);
                    if (!string.IsNullOrEmpty(processFilter) && !ProcessMatches(process, processFilter)) return true;
                    result.Add(new WindowEntry {
                        Hwnd = hwnd,
                        Pid = (int)pid,
                        Process = process,
                        Title = SafeText(title, 300),
                        ClassName = SafeText(windowClass, MaxAnchorLength),
                        Rect = rect,
                        Foreground = GetForegroundWindow() == hwnd
                    });
                }
                catch
                {
                    // Skip windows that disappear while enumerating.
                }
                return true;
            }, IntPtr.Zero);
            return result;
        }

        internal static Dictionary<string, object> DescribePoint(int x, int y)
        {
            return UiaDispatcher.Run<Dictionary<string, object>>(delegate { return DescribePointCore(x, y); }, 30000);
        }

        private static Dictionary<string, object> DescribePointCore(int x, int y)
        {
            POINT point;
            point.x = x;
            point.y = y;
            IntPtr hwnd = GetAncestor(WindowFromPoint(point), 2);
            if (hwnd == IntPtr.Zero) return null;
            string title = WindowTitle(hwnd);
            if (title.Length == 0) return null;
            string className = WindowClass(hwnd);
            if (string.Equals(className, "Progman", StringComparison.OrdinalIgnoreCase)
                || string.Equals(className, "Shell_TrayWnd", StringComparison.OrdinalIgnoreCase)
                || string.Equals(className, "WorkerW", StringComparison.OrdinalIgnoreCase)) return null;
            IntRect rect;
            if (!TryGetWindowRect(hwnd, out rect)) return null;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);

            var window = new Dictionary<string, object> {
                { "hwnd", hwnd.ToInt64() },
                { "pid", (int)pid },
                { "process", ProcessName((int)pid) },
                { "title", SafeText(title, 300) },
                { "className", SafeText(className, MaxAnchorLength) },
                { "rect", rect.ToJson() },
                { "foreground", GetForegroundWindow() == hwnd }
            };

            Dictionary<string, object> element = null;
            try
            {
                AutomationElement hit = AutomationElement.FromPoint(new System.Windows.Point(x, y));
                AutomationElement target = PickMeaningful(hit);
                if (target != null) element = DescribeElement(target);
            }
            catch
            {
                // UIA can race with the target app; the window metadata is still useful.
            }

            var result = new Dictionary<string, object>();
            result["window"] = window;
            result["element"] = element;
            result["point"] = new Dictionary<string, object> { { "x", x }, { "y", y } };
            return result;
        }

        private static AutomationElement PickMeaningful(AutomationElement element)
        {
            if (element == null) return null;
            AutomationElement current = element;
            AutomationElement fallback = null;
            for (int depth = 0; depth < 8 && current != null; depth++)
            {
                try
                {
                    string typeName = ControlTypeName(current.Current.ControlType);
                    if (Array.IndexOf(InterestingTypes, typeName) >= 0) return current;
                    if (typeName == "Pane" || typeName == "Custom" || typeName == "Text")
                    {
                        if (IsUsefulRole(LegacyRole(current))) return current;
                    }
                    if (fallback == null && (!string.IsNullOrEmpty(current.Current.Name)
                        || !string.IsNullOrEmpty(current.Current.AutomationId))) fallback = current;
                    current = TreeWalker.ControlViewWalker.GetParent(current);
                }
                catch
                {
                    break;
                }
            }
            return fallback;
        }

        private static bool IsUsefulRole(int role)
        {
            return role == RoleText || role == RolePushButton || role == RoleLink || role == RoleListItem
                || role == RolePageTab || role == RoleComboBox || role == RoleOutlineItem
                || role == RoleMenuItem || role == RoleDocument || role == RoleButtonDropDown;
        }

        private static Dictionary<string, object> DescribeElement(AutomationElement element)
        {
            AutomationElement.AutomationElementInformation current = element.Current;
            string typeName = ControlTypeName(current.ControlType);
            string className = SafeText(current.ClassName, MaxAnchorLength);
            bool editable = false;
            bool invokable = false;
            bool selectable = false;
            bool selected = false;
            bool expandable = false;
            object pattern;
            if (typeName == "Edit" || typeName == "Document")
            {
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                {
                    try { editable = !((ValuePattern)pattern).Current.IsReadOnly; } catch { }
                }
                else
                {
                    try { editable = current.IsEnabled && current.IsKeyboardFocusable; } catch { }
                }
            }
            if (typeName == "Group" || typeName == "Pane" || typeName == "Custom")
            {
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                {
                    try { if (!((ValuePattern)pattern).Current.IsReadOnly) editable = true; } catch { }
                }
                if (!editable && IsEditorSurface(className, SafeText(current.AutomationId, MaxAnchorLength)))
                {
                    try { editable = current.IsEnabled && current.IsKeyboardFocusable; } catch { }
                }
            }
            if (typeName == "Button" && element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) invokable = true;
            if (typeName == "Button" && element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) expandable = true;
            if ((typeName == "ListItem" || typeName == "TabItem" || typeName == "TreeItem")
                && element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
            {
                selectable = true;
                try { selected = ((SelectionItemPattern)pattern).Current.IsSelected; } catch { }
            }
            int legacyRole = -1;
            if (typeName == "Pane" || typeName == "Text" || typeName == "Custom" || typeName == "Group")
            {
                legacyRole = LegacyRole(element);
                if (legacyRole == RoleText || legacyRole == RoleDocument) editable = true;
                if (legacyRole == RoleListItem || legacyRole == RolePageTab || legacyRole == RoleOutlineItem) selectable = true;
                if (legacyRole == RoleButtonDropDown) expandable = true;
            }

            var ancestors = new List<object>();
            try
            {
                AutomationElement parent = TreeWalker.ControlViewWalker.GetParent(element);
                for (int depth = 0; depth < 4 && parent != null; depth++)
                {
                    AutomationElement.AutomationElementInformation info = parent.Current;
                    string parentType = ControlTypeName(info.ControlType);
                    if (parentType == "Window" || parentType == "Pane" && depth > 0) break;
                    if (!string.IsNullOrEmpty(info.Name) || !string.IsNullOrEmpty(info.AutomationId))
                    {
                        ancestors.Add(new Dictionary<string, object> {
                            { "name", SafeText(info.Name, MaxNameLength) },
                            { "automationId", SafeText(info.AutomationId, MaxAnchorLength) },
                            { "controlType", parentType }
                        });
                    }
                    parent = TreeWalker.ControlViewWalker.GetParent(parent);
                }
            }
            catch { }

            var result = new Dictionary<string, object> {
                { "name", SafeText(current.Name, MaxNameLength) },
                { "automationId", SafeText(current.AutomationId, MaxAnchorLength) },
                { "className", SafeText(current.ClassName, MaxAnchorLength) },
                { "controlType", typeName },
                { "rect", RectDictionary(current.BoundingRectangle) },
                { "enabled", current.IsEnabled },
                { "keyboardFocusable", current.IsKeyboardFocusable },
                { "editable", editable },
                { "invokable", invokable },
                { "selectable", selectable },
                { "selected", selected },
                { "expandable", expandable },
                { "ancestors", ancestors }
            };
            if (legacyRole >= 0) result["legacyRole"] = legacyRole;
            return result;
        }

        private static Dictionary<string, object> WindowDictionary(WindowEntry window)
        {
            return new Dictionary<string, object> {
                { "hwnd", window.Hwnd.ToInt64() },
                { "pid", window.Pid },
                { "process", window.Process },
                { "title", window.Title },
                { "className", window.ClassName },
                { "rect", window.Rect.ToJson() },
                { "foreground", window.Foreground }
            };
        }

        private static Dictionary<string, object> RectDictionary(System.Windows.Rect rect)
        {
            return new Dictionary<string, object> {
                { "x", (int)Math.Round(rect.Left) },
                { "y", (int)Math.Round(rect.Top) },
                { "w", (int)Math.Round(rect.Width) },
                { "h", (int)Math.Round(rect.Height) }
            };
        }

        private static string ControlTypeName(ControlType type)
        {
            string name = type == null ? string.Empty : type.ProgrammaticName;
            const string prefix = "ControlType.";
            return name.StartsWith(prefix, StringComparison.Ordinal) ? name.Substring(prefix.Length) : name;
        }

        private static string SafeText(string value, int max)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            string text = value.Trim();
            return text.Length <= max ? text : text.Substring(0, max);
        }

        private static string NormalizeProcess(string value)
        {
            if (string.IsNullOrEmpty(value)) return null;
            string process = value.Trim();
            if (process.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) process = process.Substring(0, process.Length - 4);
            return process.Length == 0 ? null : process;
        }

        private static bool ProcessMatches(string process, string filter)
        {
            string name = NormalizeProcess(process);
            return string.Equals(name, filter, StringComparison.OrdinalIgnoreCase);
        }
    }

    internal static class MouseRecorder
    {
        private const int WhMouseLL = 14;
        private const int WmLButtonDown = 0x0201;
        private const int WmQuit = 0x0012;
        private const int MaxEvents = 300;

        private sealed class RawEvent
        {
            public string Kind;
            public int X;
            public int Y;
            public DateTime At;
        }

        private static readonly object Sync = new object();
        private static readonly object EventLock = new object();
        private static readonly Queue<RawEvent> Pending = new Queue<RawEvent>();
        private static readonly List<Dictionary<string, object>> Events = new List<Dictionary<string, object>>();
        private static readonly ManualResetEvent HookReady = new ManualResetEvent(false);

        private static Thread _hookThread;
        private static Thread _workerThread;
        private static LowLevelMouseProc _hookProc;
        private static IntPtr _hook;
        private static uint _hookThreadId;
        private static volatile bool _active;
        private static volatile bool _autoStopped;
        private static volatile bool _hasResult;
        private static DateTime _startedAt;
        private static int _maxSeconds = 300;
        private static int _anchorX;
        private static int _anchorY;
        private static DateTime _stableSince;
        private static bool _hoverRecorded;
        private static int _hookError;

        public static Dictionary<string, object> Start(Dictionary<string, object> args)
        {
            lock (Sync)
            {
                if (_active) throw new HelperException("ALREADY_RECORDING", "A recording is already in progress.");
                if (_hookThread != null) StopLocked();
                Events.Clear();
                lock (EventLock) { Pending.Clear(); }
                _autoStopped = false;
                _hasResult = false;
                _hookError = 0;
                _startedAt = DateTime.UtcNow;
                _maxSeconds = Clamp(GetInt(args, "maxSeconds", 300), 15, 300);
                POINT cursor;
                if (!GetCursorPos(out cursor)) { cursor.x = 0; cursor.y = 0; }
                _anchorX = cursor.x;
                _anchorY = cursor.y;
                _stableSince = DateTime.UtcNow;
                _hoverRecorded = false;
                _hookProc = HookCallback;
                HookReady.Reset();
                _hookThread = new Thread(HookThread);
                _hookThread.IsBackground = true;
                _hookThread.Name = "InsomniaZMouseHook";
                _hookThread.Start();
                HookReady.WaitOne(2000);
                if (_hook == IntPtr.Zero)
                {
                    _active = false;
                    throw new HelperException("HOOK_FAILED", "Could not install the mouse hook (win32 " + _hookError + ").");
                }
                _active = true;
                _workerThread = new Thread(WorkerLoop);
                _workerThread.IsBackground = true;
                _workerThread.Name = "InsomniaZRecorder";
                _workerThread.Start();
                Log("info", "recording started; maxSeconds=" + _maxSeconds);
                return StatusLocked();
            }
        }

        public static Dictionary<string, object> Stop()
        {
            lock (Sync)
            {
                if (!_active && !_hasResult) throw new HelperException("NOT_RECORDING", "No recording is in progress.");
                if (_active) StopLocked();
                var result = new Dictionary<string, object>();
                List<Dictionary<string, object>> snapshot;
                lock (EventLock)
                {
                    snapshot = new List<Dictionary<string, object>>(Events);
                }
                result["recording"] = false;
                result["startedAt"] = _startedAt.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
                result["durationMs"] = (int)Math.Max(0, (DateTime.UtcNow - _startedAt).TotalMilliseconds);
                result["autoStopped"] = _autoStopped;
                result["count"] = snapshot.Count;
                result["events"] = snapshot;
                lock (EventLock)
                {
                    Events.Clear();
                    Pending.Clear();
                }
                _hasResult = false;
                Log("info", "recording stopped; events=" + snapshot.Count + " autoStopped=" + _autoStopped);
                return result;
            }
        }

        public static Dictionary<string, object> Status()
        {
            lock (Sync)
            {
                var result = StatusLocked();
                lock (EventLock) { result["eventCount"] = Events.Count; }
                return result;
            }
        }

        private static Dictionary<string, object> StatusLocked()
        {
            var result = new Dictionary<string, object>();
            result["recording"] = _active;
            result["startedAt"] = _startedAt == default(DateTime)
                ? null
                : _startedAt.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
            result["maxSeconds"] = _maxSeconds;
            result["remainingMs"] = _active
                ? (int)Math.Max(0, _maxSeconds * 1000 - (DateTime.UtcNow - _startedAt).TotalMilliseconds)
                : 0;
            result["autoStopped"] = _autoStopped;
            lock (EventLock) { result["eventCount"] = Events.Count; }
            return result;
        }

        private static void StopLocked()
        {
            _active = false;
            _hasResult = true;
            if (_hookThreadId != 0) PostThreadMessage(_hookThreadId, WmQuit, IntPtr.Zero, IntPtr.Zero);
            Thread hook = _hookThread;
            Thread worker = _workerThread;
            _hookThread = null;
            _workerThread = null;
            try { if (hook != null && hook != Thread.CurrentThread) hook.Join(2000); } catch { }
            try { if (worker != null && worker != Thread.CurrentThread) worker.Join(2000); } catch { }
            _hookThreadId = 0;
        }

        private static void HookThread()
        {
            _hookThreadId = GetCurrentThreadId();
            _hookProc = HookCallback;
            _hook = SetWindowsHookEx(WhMouseLL, _hookProc, GetModuleHandle(null), 0);
            if (_hook == IntPtr.Zero)
            {
                _hookError = Marshal.GetLastWin32Error();
                HookReady.Set();
                return;
            }
            HookReady.Set();
            MSG message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
            if (_hook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(_hook);
                _hook = IntPtr.Zero;
            }
        }

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && _active && wParam.ToInt32() == WmLButtonDown)
            {
                try
                {
                    MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                    Enqueue("click", data.pt.x, data.pt.y);
                }
                catch { }
            }
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        private static void Enqueue(string kind, int x, int y)
        {
            lock (EventLock)
            {
                if (Events.Count + Pending.Count >= MaxEvents) return;
                Pending.Enqueue(new RawEvent { Kind = kind, X = x, Y = y, At = DateTime.UtcNow });
            }
        }

        private static void WorkerLoop()
        {
            while (_active)
            {
                if ((DateTime.UtcNow - _startedAt).TotalSeconds >= _maxSeconds)
                {
                    _autoStopped = true;
                    _hasResult = true;
                    _active = false;
                    if (_hookThreadId != 0) PostThreadMessage(_hookThreadId, WmQuit, IntPtr.Zero, IntPtr.Zero);
                    Log("info", "recording auto-stopped after " + _maxSeconds + " seconds");
                    break;
                }

                List<RawEvent> batch;
                lock (EventLock)
                {
                    batch = new List<RawEvent>(Pending);
                    Pending.Clear();
                }
                foreach (RawEvent raw in batch) Enrich(raw);

                POINT cursor;
                if (GetCursorPos(out cursor))
                {
                    int dx = Math.Abs(cursor.x - _anchorX);
                    int dy = Math.Abs(cursor.y - _anchorY);
                    if (dx > 6 || dy > 6)
                    {
                        _anchorX = cursor.x;
                        _anchorY = cursor.y;
                        _stableSince = DateTime.UtcNow;
                        _hoverRecorded = false;
                    }
                    else if (!_hoverRecorded && (DateTime.UtcNow - _stableSince).TotalMilliseconds >= 850)
                    {
                        _hoverRecorded = true;
                        Enrich(new RawEvent { Kind = "hover", X = cursor.x, Y = cursor.y, At = DateTime.UtcNow });
                    }
                }
                Thread.Sleep(70);
            }
        }

        private static void Enrich(RawEvent raw)
        {
            lock (EventLock)
            {
                if (Events.Count >= MaxEvents) return;
            }
            Dictionary<string, object> described;
            try { described = GuiAutomation.DescribePoint(raw.X, raw.Y); }
            catch { described = null; }
            if (described == null) return;

            var item = new Dictionary<string, object>();
            item["kind"] = raw.Kind;
            item["at"] = raw.At.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
            item["offsetMs"] = (int)Math.Max(0, (raw.At - _startedAt).TotalMilliseconds);
            item["x"] = raw.X;
            item["y"] = raw.Y;
            item["window"] = described["window"];
            item["element"] = described["element"];
            lock (EventLock) { Events.Add(item); }
        }
    }

    private sealed class RecoveryRecord
    {
        public string version { get; set; }
        public string scheme { get; set; }
        public uint ac { get; set; }
        public uint dc { get; set; }
        public string appliedAt { get; set; }
        public int pid { get; set; }
    }

    private static Dictionary<string, object> Response(int id, bool ok, object data, object error)
    {
        var message = new Dictionary<string, object>();
        message["id"] = id;
        message["ok"] = ok;
        if (data != null) message["data"] = data;
        if (error != null) message["error"] = error;
        return message;
    }

    private static object Error(string code, string message)
    {
        return new Dictionary<string, object> { { "code", code }, { "message", message } };
    }

    private static Dictionary<string, object> GetDict(Dictionary<string, object> source, string key)
    {
        object value;
        if (source != null && source.TryGetValue(key, out value))
        {
            var dict = value as Dictionary<string, object>;
            if (dict != null) return dict;
        }
        return new Dictionary<string, object>();
    }

    private static string GetString(Dictionary<string, object> source, string key)
    {
        object value;
        if (source != null && source.TryGetValue(key, out value) && value != null) return Convert.ToString(value, CultureInfo.InvariantCulture);
        return null;
    }

    private static bool GetBool(Dictionary<string, object> source, string key)
    {
        object value;
        if (source != null && source.TryGetValue(key, out value) && value != null)
        {
            try { return Convert.ToBoolean(value, CultureInfo.InvariantCulture); } catch { return false; }
        }
        return false;
    }

    private static int ToInt(object value, int fallback)
    {
        try { return Convert.ToInt32(value, CultureInfo.InvariantCulture); }
        catch { return fallback; }
    }

    private static class PowerApi
    {
        [DllImport("powrprof.dll", SetLastError = true)]
        private static extern uint PowerGetActiveScheme(IntPtr userRootPowerKey, out IntPtr activePolicyGuid);

        [DllImport("powrprof.dll", SetLastError = true)]
        private static extern uint PowerReadACValueIndex(IntPtr rootPowerKey, ref Guid schemeGuid, ref Guid subGroupGuid, ref Guid powerSettingGuid, out uint valueIndex);

        [DllImport("powrprof.dll", SetLastError = true)]
        private static extern uint PowerReadDCValueIndex(IntPtr rootPowerKey, ref Guid schemeGuid, ref Guid subGroupGuid, ref Guid powerSettingGuid, out uint valueIndex);

        [DllImport("powrprof.dll", SetLastError = true)]
        private static extern uint PowerWriteACValueIndex(IntPtr rootPowerKey, ref Guid schemeGuid, ref Guid subGroupGuid, ref Guid powerSettingGuid, uint valueIndex);

        [DllImport("powrprof.dll", SetLastError = true)]
        private static extern uint PowerWriteDCValueIndex(IntPtr rootPowerKey, ref Guid schemeGuid, ref Guid subGroupGuid, ref Guid powerSettingGuid, uint valueIndex);

        [DllImport("powrprof.dll", SetLastError = true)]
        private static extern uint PowerSetActiveScheme(IntPtr userRootPowerKey, ref Guid schemeGuid);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr hMem);

        public static bool TryGetActiveScheme(out Guid scheme)
        {
            scheme = Guid.Empty;
            IntPtr ptr;
            uint rc = PowerGetActiveScheme(IntPtr.Zero, out ptr);
            if (rc != 0 || ptr == IntPtr.Zero) return false;
            try
            {
                scheme = (Guid)Marshal.PtrToStructure(ptr, typeof(Guid));
                return true;
            }
            finally
            {
                LocalFree(ptr);
            }
        }

        public static bool TryReadLid(out Guid scheme, out uint ac, out uint dc, out uint rcAc, out uint rcDc)
        {
            ac = 0;
            dc = 0;
            rcAc = 0;
            rcDc = 0;
            if (!TryGetActiveScheme(out scheme)) return false;
            Guid sub = SUB_BUTTONS;
            Guid lid = LID_ACTION;
            rcAc = PowerReadACValueIndex(IntPtr.Zero, ref scheme, ref sub, ref lid, out ac);
            rcDc = PowerReadDCValueIndex(IntPtr.Zero, ref scheme, ref sub, ref lid, out dc);
            return rcAc == 0 && rcDc == 0;
        }

        public static bool TryWriteLid(Guid scheme, uint ac, uint dc, out uint errorCode)
        {
            Guid sub = SUB_BUTTONS;
            Guid lid = LID_ACTION;
            uint rcAc = PowerWriteACValueIndex(IntPtr.Zero, ref scheme, ref sub, ref lid, ac);
            uint rcDc = PowerWriteDCValueIndex(IntPtr.Zero, ref scheme, ref sub, ref lid, dc);
            uint rcActive = PowerSetActiveScheme(IntPtr.Zero, ref scheme);
            errorCode = rcAc != 0 ? rcAc : (rcDc != 0 ? rcDc : rcActive);
            return rcAc == 0 && rcDc == 0 && rcActive == 0;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SYSTEM_POWER_STATUS
    {
        public byte ACLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte SystemStatusFlag;
        public uint BatteryLifeTime;
        public uint BatteryFullLifeTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint flags);

    [DllImport("kernel32.dll")]
    private static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT pt);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string moduleName);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    [DllImport("powrprof.dll", SetLastError = true)]
    private static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, uint coInit);

    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromPoint(POINT ptScreen,
        [MarshalAs(UnmanagedType.Interface)] out Accessibility.IAccessible accessible, ref object child);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    private static int GetInt(Dictionary<string, object> source, string key, int fallback)
    {
        object value;
        if (source != null && source.TryGetValue(key, out value) && value != null)
        {
            try { return Convert.ToInt32(value, CultureInfo.InvariantCulture); } catch { }
        }
        return fallback;
    }

    private static long GetLong(Dictionary<string, object> source, string key, long fallback)
    {
        object value;
        if (source != null && source.TryGetValue(key, out value) && value != null)
        {
            try { return Convert.ToInt64(value, CultureInfo.InvariantCulture); } catch { }
        }
        return fallback;
    }

    private static int Clamp(int value, int min, int max)
    {
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    private static string ProcessName(int pid)
    {
        try
        {
            string name = Process.GetProcessById(pid).ProcessName;
            return name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name : name + ".exe";
        }
        catch
        {
            return "unknown";
        }
    }

    private static string WindowTitle(IntPtr hwnd)
    {
        try
        {
            int length = GetWindowTextLength(hwnd);
            if (length <= 0) return string.Empty;
            var buffer = new StringBuilder(length + 2);
            GetWindowText(hwnd, buffer, buffer.Capacity);
            return buffer.ToString().Trim();
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string WindowClass(IntPtr hwnd)
    {
        try
        {
            var buffer = new StringBuilder(256);
            GetClassName(hwnd, buffer, buffer.Capacity);
            return buffer.ToString();
        }
        catch
        {
            return string.Empty;
        }
    }

    private static bool TryGetWindowRect(IntPtr hwnd, out IntRect rect)
    {
        rect = null;
        RECT raw;
        if (!GetWindowRect(hwnd, out raw)) return false;
        int width = raw.Right - raw.Left;
        int height = raw.Bottom - raw.Top;
        if (width <= 0 || height <= 0) return false;
        rect = new IntRect { X = raw.Left, Y = raw.Top, W = width, H = height };
        return true;
    }

    private static void SendMouse(uint flags)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = 0;
        inputs[0].Data.mi.dx = 0;
        inputs[0].Data.mi.dy = 0;
        inputs[0].Data.mi.mouseData = 0;
        inputs[0].Data.mi.dwFlags = flags;
        inputs[0].Data.mi.time = 0;
        inputs[0].Data.mi.dwExtraInfo = IntPtr.Zero;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void SendVirtualKey(ushort vk, bool up)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = 1;
        inputs[0].Data.ki.wVk = vk;
        inputs[0].Data.ki.wScan = 0;
        inputs[0].Data.ki.dwFlags = up ? 0x0002u : 0u;
        inputs[0].Data.ki.time = 0;
        inputs[0].Data.ki.dwExtraInfo = IntPtr.Zero;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static void SendUnicodeText(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        const int chunk = 80;
        int offset = 0;
        while (offset < text.Length)
        {
            int length = Math.Min(chunk, text.Length - offset);
            INPUT[] inputs = new INPUT[length * 2];
            for (int i = 0; i < length; i++)
            {
                char ch = text[offset + i];
                int index = i * 2;
                inputs[index].type = 1;
                inputs[index].Data.ki.dwFlags = 0x0004u;
                inputs[index].Data.ki.dwExtraInfo = IntPtr.Zero;
                inputs[index + 1].type = 1;
                inputs[index + 1].Data.ki.dwFlags = 0x0006u;
                inputs[index + 1].Data.ki.dwExtraInfo = IntPtr.Zero;
                if (ch == '\n')
                {
                    inputs[index].Data.ki.wVk = 0x0D;
                    inputs[index + 1].Data.ki.wVk = 0x0D;
                }
                else if (ch == '\t')
                {
                    inputs[index].Data.ki.wVk = 0x09;
                    inputs[index + 1].Data.ki.wVk = 0x09;
                }
                else
                {
                    inputs[index].Data.ki.wVk = 0;
                    inputs[index].Data.ki.wScan = (ushort)ch;
                    inputs[index + 1].Data.ki.wVk = 0;
                    inputs[index + 1].Data.ki.wScan = (ushort)ch;
                }
            }
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            offset += length;
            Thread.Sleep(12);
        }
    }
}
