[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DataDirectory,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [string]$Version = '0.4.4',
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\open-dashboard.mjs'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js was not found.' }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Dashboard launcher was not found.' }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Web.Extensions
Add-Type -WarningAction SilentlyContinue -ReferencedAssemblies System.dll, System.Windows.Forms.dll, System.Drawing.dll, System.Web.Extensions.dll -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class ContextMonitorDesktop : ApplicationContext
{
    private sealed class HotkeyWindow : NativeWindow, IDisposable
    {
        [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
        [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
        private readonly Action onOpen;
        public readonly bool Registered;
        public readonly int Error;
        public readonly string Shortcut;
        public HotkeyWindow(Action action)
        {
            onOpen = action;
            CreateHandle(new CreateParams { Parent = new IntPtr(-3) });
            Registered = RegisterHotKey(Handle, 1, 0x4003, 0x4D); // Ctrl+Alt+M; no repeat
            Error = Registered ? 0 : Marshal.GetLastWin32Error();
            Shortcut = Registered ? "Ctrl+Alt+M" : "";
            if (!Registered && Error == 1409)
            {
                Registered = RegisterHotKey(Handle, 1, 0x4007, 0x4D); // Existing shortcuts keep ownership.
                Error = Registered ? 0 : Marshal.GetLastWin32Error();
                Shortcut = Registered ? "Ctrl+Alt+Shift+M" : "";
            }
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x0312 && message.WParam.ToInt32() == 1) onOpen();
            base.WndProc(ref message);
        }
        public void Dispose() { if (Registered) UnregisterHotKey(Handle, 1); DestroyHandle(); }
    }
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr handle);
    private readonly string directory, node, launcher, version, instance = Guid.NewGuid().ToString("N");
    private readonly NotifyIcon tray;
    private readonly Icon icon;
    private readonly HotkeyWindow hotkey;
    private readonly System.Windows.Forms.Timer timer;
    private readonly Mutex mutex;
    private Process opening;
    private string lastLaunch, lastError;
    private DateTime lastClick = DateTime.MinValue;
    public ContextMonitorDesktop(string dataDirectory, string nodePath, string launcherPath, string appVersion)
    {
        directory = dataDirectory; node = nodePath; launcher = launcherPath; version = appVersion;
        Directory.CreateDirectory(directory);
        string key;
        using (var hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(directory).ToUpperInvariant()))).Replace("-", "");
        bool created;
        mutex = new Mutex(true, "Local\\CodexContextMonitor-" + key, out created);
        if (!created) { mutex.Dispose(); throw new InvalidOperationException("Desktop entry already running."); }
        icon = MakeIcon();
        tray = new NotifyIcon { Icon = icon };
        hotkey = new HotkeyWindow(Open);
        tray.Text = "\u4e0a\u4e0b\u6587\u76d1\u63a7" + (hotkey.Registered ? " | " + hotkey.Shortcut : "");
        var menu = new ContextMenuStrip();
        menu.Items.Add("\u6253\u5f00\u4e0a\u4e0b\u6587\u76d1\u63a7  " + hotkey.Shortcut, null, (s, e) => Open());
        menu.Items.Add("\u9000\u51fa\u6258\u76d8\u5165\u53e3", null, (s, e) => ExitThread());
        tray.ContextMenuStrip = menu;
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Open(); };
        tray.Visible = true;
        SaveState();
        timer = new System.Windows.Forms.Timer { Interval = 1000 };
        timer.Tick += (s, e) =>
        {
            if (File.Exists(Path.Combine(directory, "desktop-stop-" + instance)) || !File.Exists(launcher)) { ExitThread(); return; }
            if (opening != null && opening.HasExited)
            {
                if (opening.ExitCode != 0) lastError = "Dashboard launch failed (" + opening.ExitCode + ").";
                opening.Dispose(); opening = null;
            }
            SaveState();
        };
        timer.Start();
    }
    private void Open()
    {
        if ((DateTime.UtcNow - lastClick).TotalMilliseconds < 750 || (opening != null && !opening.HasExited)) return;
        lastClick = DateTime.UtcNow;
        try
        {
            opening = Process.Start(new ProcessStartInfo(node, "\"" + launcher + "\" --recent")
            {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(launcher)
            });
            lastLaunch = DateTime.UtcNow.ToString("o"); lastError = null;
        }
        catch (Exception error) { lastError = error.Message; }
        SaveState();
    }
    private void SaveState()
    {
        var state = new { application = "context-window-monitor", version = version, pid = Process.GetCurrentProcess().Id,
            instanceId = instance, updatedAt = DateTime.UtcNow.ToString("o"), visible = tray.Visible,
            hotkeyRegistered = hotkey.Registered, hotkey = hotkey.Shortcut, hotkeyError = hotkey.Error, lastLaunchAt = lastLaunch, lastError = lastError };
        string target = Path.Combine(directory, "desktop-entry.json"), temporary = target + ".tmp";
        try
        {
            File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(state), new UTF8Encoding(false));
            if (File.Exists(target)) File.Replace(temporary, target, null); else File.Move(temporary, target);
        }
        catch (IOException) { /* Retry on the next tick when a reader briefly holds the file. */ }
    }
    private static Icon MakeIcon()
    {
        using (var bitmap = new Bitmap(32, 32))
        using (var graphics = Graphics.FromImage(bitmap))
        using (var ring = new Pen(Color.FromArgb(34, 211, 170), 3))
        using (var bars = new SolidBrush(Color.White))
        {
            graphics.Clear(Color.Transparent);
            graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            graphics.FillEllipse(Brushes.Black, 1, 1, 30, 30);
            graphics.DrawEllipse(ring, 2, 2, 28, 28);
            graphics.FillRectangle(bars, 8, 17, 4, 7);
            graphics.FillRectangle(bars, 14, 12, 4, 12);
            graphics.FillRectangle(bars, 20, 8, 4, 16);
            var handle = bitmap.GetHicon();
            try { using (var original = Icon.FromHandle(handle)) return (Icon)original.Clone(); }
            finally { DestroyIcon(handle); }
        }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            timer.Stop(); timer.Dispose(); hotkey.Dispose(); tray.Visible = false;
            tray.ContextMenuStrip.Dispose(); tray.Dispose(); icon.Dispose();
            opening = null; // An already requested browser launch may finish independently.
            try { File.Delete(Path.Combine(directory, "desktop-entry.json")); File.Delete(Path.Combine(directory, "desktop-stop-" + instance)); } catch (IOException) { }
            mutex.ReleaseMutex(); mutex.Dispose();
        }
        base.Dispose(disposing);
    }
}
'@
if ($CheckOnly) {
    @{ compiled = $true; nodeFound = $true; launcherFound = $true; hotkey = 'Ctrl+Alt+M' } | ConvertTo-Json -Compress
    exit 0
}
try {
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $context = New-Object -TypeName ContextMonitorDesktop -ArgumentList @($DataDirectory, $NodePath, $launcher, $Version)
    try { [System.Windows.Forms.Application]::Run($context) } finally { $context.Dispose() }
} catch {
    if ($_.Exception.ToString().Contains('Desktop entry already running.')) { exit 0 }
    throw
}
