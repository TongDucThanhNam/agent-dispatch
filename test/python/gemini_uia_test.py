import importlib.util
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gemini_uia", Path(__file__).parents[2] / "assets/python/gemini_uia.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SID = "gemini_1234567890abcdef"
URL = "https://gemini.google.com/app/1234567890abcdef"


def element(id="", text="", type=50026, name="", value=""):
    return NS(CurrentAutomationId=id, text=text, CurrentControlType=type, CurrentName=name, value=value)


def snapshot(**kwargs):
    return dict(dict(url="https://gemini.google.com/app", composer=element(), draft="", send=[], stop=[],
                     copies=[], model="Flash Cao", users=[], responses=[], links=[]), **kwargs)


class ScriptedDesktop(m.Desktop):
    def __init__(self, states, initial=None):
        self.states = iter(states)
        self.current = initial or snapshot()
        self.initial = self.current
        self.invocations = []
        self.clock = 0

    def snapshot(self):
        self.current = next(self.states, self.current)
        return self.current

    def navigate(self, state, session_id=None):
        return state

    def until(self, condition, timeout=25):
        return snapshot(send=["send"])

    def value(self, e):
        return NS(SetValue=lambda prompt: None)

    def invoke(self, e):
        self.invocations.append(e)

    def pause(self, seconds=0.5):
        self.clock += seconds

    def text(self, e):
        return e.text


class GeminiStateMachine(unittest.TestCase):
    def run_script(self, desktop, request):
        events = []
        with patch.object(m.time, "monotonic", lambda: desktop.clock), patch.object(m, "emit", lambda event, **data: events.append(dict(event=event, **data))):
            desktop.run(request)
        return events

    def test_waits_for_new_user_and_completed_response_not_old_answer(self):
        old = element("old", "stale")
        new = element("new", "Tiếng Việt\nsecond line")
        initial = snapshot(url=URL, users=[element("user0", "old prompt")], responses=[old], copies=["old copy"])
        done = snapshot(url=URL, users=initial["users"]+[element("user1", "prompt")], responses=[old,new], copies=["old copy","new copy"])
        pending = dict(done, stop=["stop"], copies=["old copy"])
        d = ScriptedDesktop([initial, pending, pending, done])
        events = self.run_script(d, {"prompt":"prompt", "sessionId":SID, "timeoutSeconds":20})
        self.assertEqual(d.invocations, ["send"])
        self.assertEqual(events[-1]["event"], "complete")
        self.assertEqual(events[-1]["response"], new.text)
        self.assertEqual(len([e for e in events if e["event"] == "session"]), 1)

    def test_changed_conversation_fails_without_resending(self):
        s = snapshot(url="https://gemini.google.com/app/ffffffffffffffff", users=[element("u", "prompt")])
        d = ScriptedDesktop([snapshot(url=URL), s])
        with self.assertRaisesRegex(m.TransportError, "switched conversations"):
            self.run_script(d, {"prompt":"prompt", "sessionId":SID, "timeoutSeconds":10})
        self.assertEqual(d.invocations, ["send"])

    def test_timeout_does_not_return_old_text_or_resend(self):
        initial = snapshot(url=URL, responses=[element("old", "stale")], copies=["old copy"])
        d = ScriptedDesktop([initial, dict(initial, users=[element("u", "prompt")])])
        with self.assertRaisesRegex(m.TransportError, "timed out"):
            self.run_script(d, {"prompt":"prompt", "sessionId":SID, "timeoutSeconds":3})
        self.assertEqual(d.invocations, ["send"])

    def test_mismatched_user_message_fails_without_claiming_delivery(self):
        d = ScriptedDesktop([snapshot(), snapshot(url=URL, users=[element("u", "someone else's message")])])
        with self.assertRaisesRegex(m.TransportError, "differs"):
            self.run_script(d, {"prompt":"prompt", "timeoutSeconds":10})
        self.assertEqual(d.invocations, ["send"])

    def test_real_vietnamese_stop_label_is_busy(self):
        d = object.__new__(m.Desktop)
        elements = [element(type=50030,value=URL), element(type=50004,name="Nhập câu lệnh cho Gemini",value="Hỏi Gemini\n"),
                    element(type=50000,name="Mở công cụ chọn chế độ, hiện tại là Flash Cao"),
                    element(type=50000,name="Ngừng tạo câu trả lời")]
        d.all = lambda: elements
        d.value = lambda e: NS(CurrentValue=e.value)
        s = d._snapshot()
        self.assertEqual(len(s["stop"]), 1)
        self.assertEqual(s["model"], "Flash Cao")
        with self.assertRaisesRegex(m.TransportError, "active turn"):
            d.navigate(s)

    def test_cancellation_before_submit_never_invokes_send(self):
        d = ScriptedDesktop([])
        with tempfile.TemporaryDirectory() as directory:
            stop = Path(directory) / 'stop'
            stop.write_text('stop')
            events = self.run_script(d, {"prompt":"prompt", "stopFile":str(stop)})
        self.assertEqual(d.invocations, [])
        self.assertEqual(events, [{"event":"cancelled", "sessionId":None, "beforeSubmission":True}])


if __name__ == "__main__":
    unittest.main()
