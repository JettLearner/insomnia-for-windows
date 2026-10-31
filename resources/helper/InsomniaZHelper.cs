using System;
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

[assembly: AssemblyTitle("InsomniaZ Power Helper")]
[assembly: AssemblyDescription("Keeps Windows awake and manages the lid power policy for InsomniaZ.")]
[assembly: AssemblyProduct("InsomniaZ")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class InsomniaZHelper
{
    private const string Version = "1.0.0";
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);
}
