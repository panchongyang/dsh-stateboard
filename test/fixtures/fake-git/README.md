# fake-git fixture

`fake-git.exe` is a compiled, argument-ignoring executable used only by
the `test/git/git-exec*.test.mjs` and `test/git/git-config-parse.test.mjs` safety tests. It writes the file named by `PB_GIT_MARKER` and exits
0, so a vulnerable caller — one that resolves the `git` program through the
workspace directory — leaves a marker; the fixed callers leave none.

Rebuild on Windows with the .NET Framework compiler:

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  -nologo -target:exe -optimize+ -platform:anycpu ^
  -out:fake-git.exe fake-git.cs
```

The binary is committed because the test must run deterministically without a
compiler; POSIX runners use a generated shell script instead.
