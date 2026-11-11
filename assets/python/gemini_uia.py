"""Gemini Desktop transport. Native UIA3 only: no screenshots, input injection or credentials."""
import ctypes
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def emit(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=False), flush=True)


def normalize(text):
    return text.replace("\r\n", "\n").rstrip("\n")


class TransportError(Exception):
    pass


class Desktop:
    def __init__(self, executable):
        import comtypes
        import comtypes.client
        self.com_error = comtypes.COMError
        self.com = comtypes.client
        self.uia = self.com.GetModule("UIAutomationCore.dll")
        self.auto = self.com.CreateObject(self.uia.CUIAutomation8, interface=self.uia.IUIAutomation)
        self.executable = Path(executable).resolve()
        self.root = None
        self.handler = None
        self.last = None
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        self.kernel.OpenProcess.restype = ctypes.c_void_p
        self.kernel.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
        self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        self.kernel.CreateMutexW.restype = ctypes.c_void_p
        self.kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        self.kernel.ReleaseMutex.argtypes = [ctypes.c_void_p]
        install_root = self.executable.parent.parent if self.executable.parent.name.startswith("app-") else self.executable.parent
        digest = hashlib.sha256(str(install_root).lower().encode()).hexdigest()[:24]
        self.mutex = self.kernel.CreateMutexW(None, False, "Local\\AgentDispatch.Gemini." + digest)
        if not self.mutex:
            raise TransportError("Cannot create Gemini ownership mutex.")
        if self.kernel.WaitForSingleObject(self.mutex, 0) not in (0, 0x80):
            self.kernel.CloseHandle(self.mutex)
            self.mutex = None
            raise TransportError("Gemini is owned by another dispatcher. Wait for that run.")

        user = ctypes.WinDLL("user32", use_last_error=True)
        callback_type = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
        user.EnumWindows.argtypes = [callback_type, ctypes.c_void_p]
        user.IsWindowVisible.argtypes = [ctypes.c_void_p]
        user.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        user.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
        windows = []
        def collect(hwnd, _):
            name = ctypes.create_unicode_buffer(256)
            user.GetClassNameW(hwnd, name, len(name))
            if user.IsWindowVisible(hwnd) and name.value == "Chrome_WidgetWin_1":
                pid = ctypes.c_ulong()
                user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                windows.append((hwnd, pid.value))
            return True
        user.EnumWindows(callback_type(collect), None)
        candidates = []
        for hwnd, pid in windows:
            handle = self.kernel.OpenProcess(0x1000, False, pid)
            if not handle:
                continue
            try:
                buf = ctypes.create_unicode_buffer(32768)
                size = ctypes.c_ulong(len(buf))
                if not self.kernel.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                    continue
                actual = Path(buf.value).resolve()
                # The supplied root launcher runs the app-N.N.N/Gemini.exe binary.
                valid = actual == self.executable or (
                    actual.name.lower() == "gemini.exe"
                    and actual.parent.name.startswith("app-")
                    and actual.parent.parent == self.executable.parent)
                if valid:
                    candidates.append((hwnd, pid))
            finally:
                self.kernel.CloseHandle(handle)
        if len(candidates) != 1:
            raise TransportError("Open Gemini Desktop, sign in, and leave exactly one app window available.")
        hwnd, self.pid = candidates[0]
        self.root = self.auto.ElementFromHandle(hwnd)

        class Handler(comtypes.COMObject):
            _com_interfaces_ = [self.uia.IUIAutomationEventHandler]

            def HandleAutomationEvent(self, sender, event_id):
                pass

        # Register a client and pump its events: Chromium accessibility updates
        # are asynchronous; an immediate read after an action can still be stale.
        self.handler = Handler()
        self.auto.AddAutomationEventHandler(20015, self.root, 4, None, self.handler)

    @staticmethod
    def items(collection):
        return [collection.GetElement(i) for i in range(collection.Length)]

    def all(self, root=None):
        return self.items((root or self.root).FindAll(4, self.auto.CreateTrueCondition()))

    def value(self, element):
        return element.GetCurrentPattern(10002).QueryInterface(self.uia.IUIAutomationValuePattern)

    def invoke(self, element):
        element.GetCurrentPattern(10000).QueryInterface(self.uia.IUIAutomationInvokePattern).Invoke()

    def pause(self, seconds=0.5):
        self.com.PumpEvents(seconds)

    def text(self, element):
        # A range scoped to this exact response preserves code blocks and line
        # breaks without reading the sidebar, old replies or the clipboard.
        documents = self.items(self.root.FindAll(4, self.auto.CreatePropertyCondition(30003, 50030)))
        for doc in documents:
            try:
                if self.value(doc).CurrentValue.startswith("https://gemini.google.com/"):
                    pattern = doc.GetCurrentPattern(10014).QueryInterface(self.uia.IUIAutomationTextPattern)
                    return pattern.RangeFromChild(element).GetText(-1).replace("\r\n", "\n").replace("\ufffc", "").strip()
            except Exception:
                continue
        raise TransportError("Cannot read complete text for the selected Gemini message.")

    def snapshot(self):
        for attempt in range(20):
            try:
                return self._snapshot()
            except self.com_error:
                if attempt == 19:
                    raise TransportError("Gemini accessibility kept changing; completion is unconfirmed. Inspect the app before retrying.")
                self.pause(0.25)

    def _snapshot(self):
        elements = self.all()
        docs = [e for e in elements if e.CurrentControlType == 50030]
        urls = []
        for doc in docs:
            value = self.value(doc).CurrentValue
            if re.fullmatch(r"https://gemini\.google\.com/app(?:/[a-f0-9]{16})?", value):
                urls.append(value)
        if len(urls) != 1:
            raise TransportError("Gemini chat is unavailable or blocked by a dialog; resolve it in the app.")
        edits = [e for e in elements if e.CurrentControlType == 50004 and re.search(r"Gemini", e.CurrentName)]
        if len(edits) != 1:
            raise TransportError("Gemini prompt control is unavailable or ambiguous.")
        buttons = [e for e in elements if e.CurrentControlType == 50000]
        find = lambda pattern: [e for e in buttons if re.fullmatch(pattern, e.CurrentName, re.I)]
        model_buttons = find(r"(?:Mở công cụ chọn chế độ, hiện tại là |Open mode picker, current mode is |Open mode picker, currently )(.*)")
        if len(model_buttons) != 1:
            raise TransportError("Cannot verify the current Gemini model label (supported UI: Vietnamese/English).")
        model = re.split(r"hiện tại là |current mode is |currently ", model_buttons[0].CurrentName)[-1].strip()
        users = [e for e in elements if e.CurrentAutomationId.startswith("user-query-content-")]
        responses = [e for e in elements if e.CurrentAutomationId.startswith("model-response-message-content")]
        snap = dict(url=urls[0], composer=edits[0], draft=self.value(edits[0]).CurrentValue,
                    send=find(r"Gửi tin nhắn|Send message|Send"), stop=find(r"Dừng(?:.*)|Ngừng(?:.*)|Stop(?: response| generating)?"),
                    copies=find(r"Sao chép|Copy|Copy response"), model=model, users=users, responses=responses,
                    links=[e for e in elements if e.CurrentControlType == 50005])
        self.last = snap
        return snap

    def until(self, condition, timeout=25):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pause()
            snap = self.snapshot()
            if condition(snap):
                return snap
        raise TransportError("Gemini did not confirm the UI transition; no prompt was resent.")

    def navigate(self, snap, session_id=None):
        if snap["send"] or snap["stop"]:
            raise TransportError("Gemini has a draft or active turn; it will not be overwritten.")
        target = "https://gemini.google.com/app" + ("/" + session_id.removeprefix("gemini_") if session_id else "")
        if snap["url"] == target and (session_id or not snap["users"] and not snap["responses"]):
            return snap
        candidates = [e for e in snap["links"] if self.value(e).CurrentValue == target]
        if not session_id:
            candidates = [e for e in candidates if re.fullmatch(r"Cuộc trò chuyện mới|New chat", e.CurrentName, re.I)]
        if len(candidates) != 1:
            raise TransportError("Exact conversation link is not available; open the recorded chat in Gemini and retry.")
        self.invoke(candidates[0])
        return self.until(lambda s: s["url"] == target and (session_id or not s["users"] and not s["responses"]))

    def run(self, request):
        prompt = request["prompt"]
        if request.get("stopFile") and Path(request["stopFile"]).exists():
            emit("cancelled", sessionId=None, beforeSubmission=True)
            return
        snap = self.navigate(self.snapshot(), request.get("sessionId"))
        model = snap["model"]
        if request.get("model") and request["model"] != model:
            raise TransportError("Selected Gemini model differs from the requested model. Select it in the app first.")
        previous = {e.CurrentAutomationId for e in snap["responses"]}
        copy_count = len(snap["copies"])
        user_count = len(snap["users"])
        self.value(snap["composer"]).SetValue(prompt)
        snap = self.until(lambda s: normalize(s["draft"]) == normalize(prompt) and len(s["send"]) == 1)
        if snap["model"] != model or snap["stop"]:
            raise TransportError("Gemini changed before submission; the draft was left intact.")
        if request.get("stopFile") and Path(request["stopFile"]).exists():
            emit("cancelled", sessionId=None, beforeSubmission=True)
            return
        emit("submitting", model=model)
        # Once invoked, failures are ambiguous. Never retry this action.
        self.invoke(snap["send"][0])
        started = time.monotonic()
        stable_since = None
        last_answer = None
        session_id = request.get("sessionId")
        accepted = False
        deadline = started + request.get("timeoutSeconds", 300)
        stopping = False
        while time.monotonic() < deadline:
            self.pause()
            snap = self.snapshot()
            if snap["model"] != model:
                raise TransportError("Gemini model changed during the turn; completion is unconfirmed.")
            current_id = "gemini_" + snap["url"].rsplit("/", 1)[-1]
            if re.fullmatch(r"gemini_[a-f0-9]{16}", current_id):
                if session_id and current_id != session_id:
                    raise TransportError("Gemini switched conversations; no further input was sent.")
                session_id = current_id
            if len(snap["users"]) > user_count + 1:
                raise TransportError("Another user turn appeared; Gemini ownership is no longer exclusive.")
            if len(snap["users"]) == user_count + 1 and session_id:
                observed = normalize(self.text(snap["users"][-1]))
                # Text ranges sometimes include the accessible 'You said' heading.
                if observed != normalize(prompt) and not observed.endswith("\n" + normalize(prompt)):
                    raise TransportError("The new user message differs from the submitted prompt.")
                if not accepted:
                    accepted = True
                    emit("session", sessionId=session_id, url=snap["url"], model=model)
            if not accepted:
                if time.monotonic() - started > 30:
                    raise TransportError("Message delivery is unconfirmed. Inspect Gemini before retrying.")
                continue
            if request.get("stopFile") and Path(request["stopFile"]).exists() and not stopping:
                if len(snap["stop"]) == 1:
                    self.invoke(snap["stop"][0])
                stopping = True
            fresh = [e for e in snap["responses"] if e.CurrentAutomationId not in previous]
            if len(fresh) > 1:
                raise TransportError("Multiple new assistant replies; completion is ambiguous.")
            answer = self.text(fresh[0]) if fresh else ""
            if answer and answer != last_answer:
                emit("response", sessionId=session_id, responseId=fresh[0].CurrentAutomationId, text=answer)
                stable_since = time.monotonic()
                last_answer = answer
            complete = (answer and not snap["stop"] and len(snap["copies"]) > copy_count
                        and stable_since is not None and time.monotonic() - stable_since >= 2)
            if stopping and not snap["stop"]:
                emit("cancelled", sessionId=session_id)
                return
            if complete:
                emit("complete", sessionId=session_id, responseId=fresh[0].CurrentAutomationId,
                     response=answer, url=snap["url"], model=model)
                return
        raise TransportError("Gemini timed out without verified completion; the app was left running. Do not resend automatically.")

    def close(self):
        if self.handler and self.root:
            self.auto.RemoveAutomationEventHandler(20015, self.root, self.handler)
        if self.mutex:
            self.kernel.ReleaseMutex(self.mutex)
            self.kernel.CloseHandle(self.mutex)
            self.mutex = None


def main():
    desktop = None
    try:
        request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
        desktop = Desktop(request["executable"])
        if request["action"] == "status":
            snap = desktop.snapshot()
            emit("status", ready=not snap["send"] and not snap["stop"], pid=desktop.pid,
                 model=snap["model"], url=snap["url"], hasDraft=bool(snap["send"]), busy=bool(snap["stop"]))
        else:
            desktop.run(request)
        return 0
    except Exception as error:
        # Avoid dumping arbitrary COM values, user conversations or credentials.
        message = str(error) if isinstance(error, TransportError) else "Gemini UI Automation failed (" + type(error).__name__ + "); inspect the app before retrying."
        emit("error", message=message)
        return 1
    finally:
        if desktop:
            desktop.close()


if __name__ == "__main__":
    sys.exit(main())
