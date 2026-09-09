param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string] $PipeName
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

public static class PowerShellJobGuardian
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int GuardianStoppedExitCode = 137;

    // Intentionally never closed by managed code. Process termination closes this last,
    // non-inheritable handle and causes Windows to terminate every process in the job.
    private static IntPtr jobHandle = IntPtr.Zero;
    private static StreamWriter pipeWriter;
    private static readonly object writeLock = new object();

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private sealed class Configuration
    {
        public string shell { get; set; }
        public string command { get; set; }
        public string cwd { get; set; }
        public Dictionary<string, string> env { get; set; }
    }

    private sealed class GuardianException : Exception
    {
        public GuardianException(string safeMessage) : base(safeMessage) { }
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    private static GuardianException NativeFailure(string operation)
    {
        return new GuardianException(operation + " failed (Windows error " + Marshal.GetLastWin32Error() + ")");
    }

    private static void EstablishJob()
    {
        jobHandle = CreateJobObject(IntPtr.Zero, null);
        if (jobHandle == IntPtr.Zero)
            throw NativeFailure("Job Object creation");

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        uint size = checked((uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        if (!SetInformationJobObject(jobHandle, JobObjectExtendedLimitInformation, ref limits, size))
            throw NativeFailure("Job Object limit configuration");

        using (Process current = Process.GetCurrentProcess())
        {
            if (!AssignProcessToJobObject(jobHandle, current.Handle))
                throw NativeFailure("Guardian Job Object assignment");
        }
    }

    private static void Send(object message)
    {
        lock (writeLock)
        {
            if (pipeWriter == null)
                return;
            pipeWriter.WriteLine(JsonSerializer.Serialize(message));
            pipeWriter.Flush();
        }
    }

    private static void TrySendError(string message)
    {
        try { Send(new { type = "error", message = message }); }
        catch { }
    }

    private static Configuration ParseConfiguration(string line)
    {
        Configuration config;
        try
        {
            config = JsonSerializer.Deserialize<Configuration>(line);
        }
        catch (JsonException)
        {
            throw new GuardianException("Invalid guardian configuration JSON");
        }

        if (config == null || String.IsNullOrEmpty(config.shell) || config.command == null ||
            String.IsNullOrEmpty(config.cwd) || config.env == null)
            throw new GuardianException("Guardian configuration is missing required fields");

        foreach (KeyValuePair<string, string> item in config.env)
        {
            if (String.IsNullOrEmpty(item.Key) || item.Value == null)
                throw new GuardianException("Guardian configuration contains an invalid environment entry");
        }
        return config;
    }

    private static async Task<bool> ReadStopAsync(StreamReader reader)
    {
        // Only stop is valid after configuration. EOF, broken pipe, and an
        // invalid additional command all fail closed rather than losing the lease.
        try { await reader.ReadLineAsync().ConfigureAwait(false); }
        catch (IOException) { return true; }
        catch (ObjectDisposedException) { return true; }
        return true;
    }

    public static void Run(string pipeName)
    {
        try
        {
            EstablishJob();

            var pipe = new NamedPipeClientStream(
                ".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            try { pipe.Connect(10000); }
            catch (TimeoutException) { throw new GuardianException("Named pipe connection timed out"); }
            catch (IOException) { throw new GuardianException("Named pipe connection failed"); }

            var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true);
            pipeWriter = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true);
            pipeWriter.NewLine = "\n";
            pipeWriter.AutoFlush = true;

            Send(new { type = "ready", pid = Process.GetCurrentProcess().Id });

            string configLine;
            try { configLine = reader.ReadLine(); }
            catch (IOException) { Environment.Exit(GuardianStoppedExitCode); return; }
            if (configLine == null)
            {
                Environment.Exit(GuardianStoppedExitCode);
                return;
            }
            Configuration config = ParseConfiguration(configLine);

            // Arm the disconnect/stop read before creating any workload process.
            Task<bool> stopTask = ReadStopAsync(reader);
            // Terminate even if the main thread is blocked starting a workload.
            stopTask.ContinueWith(_ => Environment.Exit(GuardianStoppedExitCode), TaskScheduler.Default);
            if (stopTask.IsCompleted && stopTask.GetAwaiter().GetResult())
            {
                Environment.Exit(GuardianStoppedExitCode);
                return;
            }

            var start = new ProcessStartInfo();
            start.UseShellExecute = false;
            start.FileName = config.shell;
            start.ArgumentList.Add("-NoLogo");
            start.ArgumentList.Add("-NoProfile");
            start.ArgumentList.Add("-NonInteractive");
            start.ArgumentList.Add("-Command");
            start.ArgumentList.Add(config.command);
            start.WorkingDirectory = config.cwd;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = false;
            start.RedirectStandardError = false;
            start.Environment.Clear();
            foreach (KeyValuePair<string, string> item in config.env)
                start.Environment[item.Key] = item.Value;

            var child = new Process();
            child.StartInfo = start;
            child.EnableRaisingEvents = true;
            try
            {
                if (!child.Start())
                    throw new GuardianException("Workload process did not start");
            }
            catch (GuardianException) { throw; }
            catch (Exception) { throw new GuardianException("Workload process start failed"); }
            child.StandardInput.Close();
            Send(new { type = "started", pid = child.Id });

            Task exitTask = child.WaitForExitAsync();
            Task.WaitAny(exitTask, stopTask);
            // Give disconnect/stop precedence if both events became observable together.
            if (stopTask.IsCompleted && stopTask.GetAwaiter().GetResult())
            {
                Environment.Exit(GuardianStoppedExitCode);
                return;
            }

            child.WaitForExit();
            int exitCode = child.ExitCode;
            Send(new { type = "exit", exitCode = exitCode });
            Environment.Exit(exitCode);
        }
        catch (GuardianException error)
        {
            Console.Error.WriteLine("PowerShell job guardian: " + error.Message);
            TrySendError(error.Message);
            Environment.Exit(1);
        }
        catch (Exception)
        {
            const string message = "Unexpected guardian failure";
            Console.Error.WriteLine("PowerShell job guardian: " + message);
            TrySendError(message);
            Environment.Exit(1);
        }
    }
}
'@

[PowerShellJobGuardian]::Run($PipeName)
