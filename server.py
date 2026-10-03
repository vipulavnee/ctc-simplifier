from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from email import policy
from email.parser import BytesParser
import io
import json
import os
import re
import zipfile
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def amount_from_match(value, unit):
    amount = float(str(value or "0").replace(",", ""))
    unit = (unit or "").lower()

    if any(token in unit for token in ("lpa", "lac", "lakh")):
        amount *= 100000
    elif "cr" in unit or "crore" in unit:
        amount *= 10000000

    return round(amount)


def find_salary_amount(text, labels):
    amount_pattern = r"(?:rs\.?|inr|â‚¹)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(lpa|lac|lakh|lakhs|cr|crore)?"

    for label in labels:
        match = re.search(rf"{label}[^0-9â‚¹]{{0,80}}{amount_pattern}", text, flags=re.I)
        if match:
            return amount_from_match(match.group(1), match.group(2))

    return 0


def find_percentage(text, labels):
    for label in labels:
        match = re.search(rf"{label}[^0-9]{{0,80}}([0-9]+(?:\.\d+)?)\s*%", text, flags=re.I)
        if match:
            return float(match.group(1))

    return 0


def find_state(text):
    match = re.search(
        r"\b(Karnataka|Delhi|Maharashtra|Tamil Nadu|Gujarat|Telangana|Haryana|West Bengal|Uttar Pradesh|Punjab|Rajasthan|Andhra Pradesh|Bangalore)\b",
        text,
        flags=re.I,
    )
    if not match:
        return ""

    state = match.group(1)
    return "Karnataka" if state.lower() == "bangalore" else state


def extract_salary_fields(text):
    clean_text = re.sub(r"\s+", " ", text)
    fields = {
        "ctc": find_salary_amount(clean_text, [r"\bctc\b", r"cost\s+to\s+company", r"total\s+compensation"]),
        "basic": find_salary_amount(clean_text, [r"\bbasic\b", r"basic\s+salary", r"basic\s+pay"]),
        "hra": find_salary_amount(clean_text, [r"\bhra\b", r"house\s+rent\s+allowance"]),
        "grossMonthly": find_salary_amount(clean_text, [r"gross\s+monthly", r"monthly\s+earnings", r"total\s+monthly\s+earnings"]),
        "da": find_salary_amount(clean_text, [r"\bda\b", r"dearness\s+allowance"]),
        "conveyance": find_salary_amount(clean_text, [r"conveyance", r"conveyance\s+allowance"]),
        "variable": find_salary_amount(clean_text, [r"variable\s+pay", r"performance\s+bonus", r"bonus"]),
        "employerPf": find_salary_amount(clean_text, [r"employer\s+pf", r"employer\s+provident\s+fund", r"company\s+pf"]),
        "gratuityMentioned": (not bool(re.search(r"gratuity\s*(?:is\s*)?(?:not\s+included|excluded|:\s*(?:no|0)\b)", clean_text, re.I))) if re.search(r"gratuity", clean_text, re.I) else None,
        "state": find_state(clean_text),
    }
    fields["warnings"] = []
    labels = {"ctc": r"ctc|cost\s+to\s+company|total\s+compensation", "basic": r"basic(?:\s+(?:salary|pay))?", "hra": r"hra|house\s+rent\s+allowance", "grossMonthly": r"gross(?:\s+monthly)?|monthly\s+earnings", "conveyance": r"conveyance(?:\s+allowance)?", "variable": r"variable\s+pay|performance\s+bonus|bonus"}
    boundary = "|".join(labels.values()) + r"|employer\s+pf|gratuity"
    for key, label in labels.items():
        match = re.search(rf"(?:\b(annual|yearly|monthly)\s+)?\b(?:{label})\b([\s\S]*?)(?=\b(?:(?:annual|yearly|monthly)\s+)?(?:{boundary})\b|$)", text, re.I)
        if not match:
            continue
        segment = match.group(2)
        numbers = list(re.finditer(r"(?:rs\.?|inr|\u20b9)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(lpa|lac|lakhs?|cr|crore)?", segment, re.I))
        if len(numbers) != 1 or re.search(r"\d\s*%", segment):
            fields[key] = 0
            fields["warnings"].append(f"{key}: multiple amounts or a percentage found; enter the amount manually.")
            continue
        period_text = (match.group(1) or "") + " " + segment
        annual = bool(re.search(r"annual|yearly|per\s+(?:year|annum)|p\.?a\.?\b|lpa", period_text, re.I))
        monthly = bool(re.search(r"monthly|per\s+month|p\.?m\.?\b", period_text, re.I))
        if annual and monthly:
            fields[key] = 0
            fields["warnings"].append(f"{key}: both monthly and annual labels found; enter the amount manually.")
            continue
        value = amount_from_match(numbers[0].group(1), numbers[0].group(2))
        target_annual = key in ("ctc", "variable")
        if annual and not target_annual:
            value /= 12
        if monthly and target_annual:
            value *= 12
        if not annual and not monthly:
            fields["warnings"].append(f"{key}: assumed {'annual' if target_annual else 'monthly'}; confirm this amount.")
        fields[key] = round(value)
    return fields


def read_docx_text(file_bytes):
    with zipfile.ZipFile(io.BytesIO(file_bytes)) as docx:
        if docx.getinfo("word/document.xml").file_size > MAX_UPLOAD_BYTES:
            raise ValueError("Document text exceeds the upload limit")
        document = ET.fromstring(docx.read("word/document.xml"))
    return " ".join(node.text or "" for node in document.iter(
        "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"
    ))


class SalaryHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        if self.path != "/api/extract":
            self.send_error(404)
            return

        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            self.send_json({"ok": False, "message": "Please upload a file."}, 400)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json({"ok": False, "message": "Invalid upload size."}, 400)
            return
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self.send_json({"ok": False, "message": "Please upload a DOCX file smaller than 10 MB."}, 413)
            return
        self.connection.settimeout(30)
        try:
            payload = self.rfile.read(length)
            message = BytesParser(policy=policy.default).parsebytes(
                ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("ascii") + payload
            )
            uploads = [part for part in message.iter_parts()
                       if part.get_param("name", header="content-disposition") == "file"]
        except (ValueError, UnicodeError, OSError):
            self.send_json({"ok": False, "message": "Could not read the upload. Please try again."}, 400)
            return

        if len(uploads) != 1 or not uploads[0].get_filename():
            self.send_json({"ok": False, "message": "No file received."}, 400)
            return

        filename = uploads[0].get_filename().lower()
        file_bytes = uploads[0].get_payload(decode=True) or b""

        if not filename.endswith(".docx"):
            self.send_json({
                "ok": False,
                "message": "Auto-reading is available for text-based DOCX files right now. For this file type, enter the values manually.",
            }, 422)
            return

        try:
            text = read_docx_text(file_bytes)
            fields = extract_salary_fields(text)
            applied_count = sum(1 for key in ("ctc", "basic", "hra", "grossMonthly", "variable", "conveyance") if fields.get(key, 0) > 0)
        except Exception:
            self.send_json({
                "ok": False,
                "message": "Could not read salary data from this Word document. Please check the document text or enter the values manually.",
            }, 422)
            return

        if applied_count == 0:
            self.send_json({
                "ok": False,
                "message": "Word document uploaded, but I could not find CTC/basic/HRA style labels. Enter or confirm the values below.",
                "fields": fields,
            }, 422)
            return

        self.send_json({
            "ok": True,
            "message": f"Word document read successfully. I filled {applied_count} salary field{'s' if applied_count != 1 else ''} and recalculated your in-hand salary.",
            "fields": fields,
        })

    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", "4174"))
    server = ThreadingHTTPServer((host, port), SalaryHandler)
    print(f"Salary Decoder running at http://{host}:{port}/index.html")
    server.serve_forever()

