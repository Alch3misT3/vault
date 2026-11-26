// Vault native messaging host for the browser extension (Chrome, Edge, Brave, Firefox).
// The browser starts this small program and talks to it over stdin/stdout; it only passes the
// bytes on to the running Vault app over a local named pipe, and back. It reads nothing, stores
// nothing and has no network access. (Everything it carries is encrypted with the pairing key.)
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

static class Relay
{
    static int Main(string[] args)
    {
        string name = Environment.GetEnvironmentVariable("VAULT_PIPE");
        if (string.IsNullOrEmpty(name)) name = "vault-browser-" + Clean(Environment.UserName);
        Stream input = Console.OpenStandardInput();
        Stream output = Console.OpenStandardOutput();
        // Overlapped I/O: reading and writing the same pipe from two threads must not block each other.
        var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        try { pipe.Connect(1500); }
        catch
        {
            // Vault isn't running (or nothing is paired): say so once, in the browser's framing.
            byte[] msg = Encoding.UTF8.GetBytes("{\"offline\":true}");
            output.Write(BitConverter.GetBytes(msg.Length), 0, 4);
            output.Write(msg, 0, msg.Length);
            output.Flush();
            return 0;
        }
        var up = new Thread(() => { Copy(input, pipe); Environment.Exit(0); });
        var down = new Thread(() => { Copy(pipe, output); Environment.Exit(0); });
        up.IsBackground = true; down.IsBackground = true;
        up.Start(); down.Start();
        up.Join();
        return 0;
    }

    static void Copy(Stream from, Stream to)
    {
        var buf = new byte[65536];
        try
        {
            int n;
            while ((n = from.Read(buf, 0, buf.Length)) > 0) { to.Write(buf, 0, n); to.Flush(); }
        }
        catch { }
    }

    static string Clean(string s)
    {
        var sb = new StringBuilder();
        foreach (char c in (s ?? "").ToLowerInvariant()) sb.Append(char.IsLetterOrDigit(c) && c < 128 ? c : '_');
        return sb.ToString();
    }
}
