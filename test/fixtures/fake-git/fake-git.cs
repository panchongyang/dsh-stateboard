using System;
using System.IO;

// Test-only fake Git executable: ignores its arguments, leaves the marker named
// by PB_GIT_MARKER, and exits 0. A caller that resolves Git through a workspace
// directory runs this instead of the real Git; test/git-exec.test.mjs asserts the
// marker stays absent. Compile with the Windows .NET Framework compiler (see
// README.md in this directory).
internal static class FakeGit
{
    private static int Main(string[] args)
    {
        string marker = Environment.GetEnvironmentVariable("PB_GIT_MARKER");
        if (!string.IsNullOrEmpty(marker))
        {
            File.WriteAllText(marker, "executed");
        }
        return 0;
    }
}
