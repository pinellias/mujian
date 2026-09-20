' ============================================================
'  MuJian - silent one-click launcher (Windows)
'  Double-click: server runs hidden in background, browser opens
'  http://127.0.0.1:8910 . No cmd window, no server window.
'  To stop, run stop.bat
' ============================================================

Option Explicit

Dim W, FSO, root, port, dataDir, logFile, pidFile
Dim nodeExe, alreadyUp, up, i, cmd, pid, f

Set W = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

root = FSO.GetParentFolderName(WScript.ScriptFullName)
If Right(root, 1) <> "\" Then root = root & "\"
port = "8910"
dataDir = root & "data\"
logFile = dataDir & "server.log"
pidFile = dataDir & ".server.pid"

' locate Node.js (prefer system install, else rely on PATH)
nodeExe = ""
If FSO.FileExists("C:\Program Files\nodejs\node.exe") Then
  nodeExe = "C:\Program Files\nodejs\node.exe"
Else
  nodeExe = "node"
End If

' ensure data dir exists
If Not FSO.FolderExists(dataDir) Then
  FSO.CreateFolder(dataDir)
End If

' sanity check: node must be runnable
If Not NodeOk(nodeExe) Then
  W.Popup "Node.js not found." & vbCrLf & _
          "Install from https://nodejs.org (LTS) and make sure 'node' is on PATH.", _
          0, "MuJian", 0 + 16
  W.Quit 1
End If

' check if server already listening
alreadyUp = PortOpen(port)

If Not alreadyUp Then
  ' launch node hidden (style 0 = no window); PID is the node process itself
  W.CurrentDirectory = root
  cmd = """" & nodeExe & """ server.js"
  pid = W.Run(cmd, 0, False)
  If pid > 0 Then
    On Error Resume Next
    Set f = FSO.CreateTextFile(pidFile, True)
    f.Write CStr(pid)
    f.Close
    On Error GoTo 0
  End If
End If

' poll until port responds (max 25s), then open browser
up = False
For i = 1 To 25
  If PortOpen(port) Then
    up = True
    Exit For
  End If
  WScript.Sleep 1000
Next

If up Then
  W.Run "http://127.0.0.1:" & port & "/", 1, False
Else
  Dim msg, logTxt
  msg = "MuJian server did not start within 25s." & vbCrLf & _
        "Check " & logFile & " for details."
  If FSO.FileExists(logFile) Then
    On Error Resume Next
    Set f = FSO.OpenTextFile(logFile, 1)
    logTxt = f.ReadAll
    f.Close
    If Len(logTxt) > 0 Then msg = msg & vbCrLf & vbCrLf & "--- log tail ---" & vbCrLf & Tail(logTxt, 20)
    On Error GoTo 0
  End If
  W.Popup msg, 0, "MuJian", 0 + 16
  W.Quit 1
End If

' ---- helpers ----

Function PortOpen(p)
  Dim http
  PortOpen = False
  On Error Resume Next
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  If Err.Number <> 0 Then Exit Function
  http.SetProxy 1                       ' WINHTTP_ACCESS_TYPE_NO_PROXY: skip proxy for localhost
  http.SetTimeouts 1000, 1000, 1000, 1000
  http.Open "GET", "http://127.0.0.1:" & p & "/", False
  http.Send
  If Err.Number = 0 Then PortOpen = True
  On Error GoTo 0
End Function

Function NodeOk(ne)
  Dim rc
  NodeOk = False
  On Error Resume Next
  rc = W.Run("""" & ne & """ -v", 0, True)   ' style 0 = hidden, wait for exit code
  If Err.Number = 0 And rc = 0 Then NodeOk = True
  On Error GoTo 0
End Function

Function Tail(txt, n)
  Dim lines, i, s
  lines = Split(txt, vbCrLf)
  s = ""
  For i = UBound(lines) - n + 1 To UBound(lines)
    If i >= 0 Then s = s & lines(i) & vbCrLf
  Next
  Tail = s
End Function
