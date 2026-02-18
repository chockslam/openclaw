# Windows PowerShell Support Plan

## Problem
The current Satellite Node implementation uses a basic execution tool that defaults to `cmd.exe` or `sh` on Windows. This causes failures when running complex commands that use:
- PowerShell syntax (loops, variables)
- Unix-style operators like `&&` (which `cmd.exe` supports but complex scripts might mix)
- Multiline scripts

## Proposed Solution (No New Dependencies)

1. **OS Detection**:
   - In `satellite-server.ts`, detect if the node is running on Windows using `os.platform() === 'win32'`.

2. **Custom Execution Tool**:
   - Instead of using the default `createExecTool`, we will instantiate it with continuous integration (CI) friendly settings or explicit shell path.
   - For Windows, we will set the shell executable to `powershell.exe`.
   - We will pass arguments `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` to ensure scripts run smoothly.

3. **Benefit**:
   - Users can write native PowerShell scripts (like the file organization script you attempted).
   - No need for `cross-env`, `execa`, or other heavy dependencies.
   - Keeps the satellite binary small and dependency-free.

## Example Implementation Logic

```typescript
const isWindows = os.platform() === "win32";

const execTool = createExecTool({
  cwd: process.cwd(),
  shell: isWindows ? "powershell.exe" : undefined,
  // potentially other options if the library supports them
});
```

*Note: If `createExecTool` doesn't support a `shell` option directly, we may need to wrap the command string in `powershell -Command "..."` before passing it to the tool.*
