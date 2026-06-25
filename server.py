from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import cgi
import json
import os
import re
import zipfile


ROOT = Path(__file__).resolve().parent


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
    return {
        "ctc": find_salary_amount(clean_text, [r"\bctc\b", r"cost\s+to\s+company", r"total\s+compensation"]),
        "basic": find_salary_amount(clean_text, [r"\bbasic\b", r"basic\s+salary", r"basic\s+pay"]),
        "hra": find_salary_amount(clean_text, [r"\bhra\b", r"house\s+rent\s+allowance"]),
        "grossMonthly": find_salary_amount(clean_text, [r"gross\s+monthly", r"monthly\s+earnings", r"total\s+monthly\s+earnings"]),
        "da": find_salary_amount(clean_text, [r"\bda\b", r"dearness\s+allowance"]),
        "conveyance": find_salary_amount(clean_text, [r"conveyance", r"conveyance\s+allowance"]),
        "variable": find_salary_amount(clean_text, [r"variable\s+pay", r"performance\s+bonus", r"bonus"]),
        "employerPf": find_salary_amount(clean_text, [r"employer\s+pf", r"employer\s+provident\s+fund", r"company\s+pf"]),
        "gratuityMentioned": bool(re.search(r"gratuity", clean_text, flags=re.I)),
        "state": find_state(clean_text),
    }


def read_docx_text(file_bytes):
    temp_path = ROOT / ".upload-temp.docx"
    temp_path.write_bytes(file_bytes)

    try:
        with zipfile.ZipFile(temp_path) as docx:
            xml = docx.read("word/document.xml").decode("utf-8", errors="ignore")
    finally:
        try:
            temp_path.unlink()
        except OSError:
            pass

    parts = re.findall(r"<w:t[^>]*>(.*?)</w:t>", xml)
    text = " ".join(re.sub(r"<[^>]+>", "", part) for part in parts)
    return (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
    )


class SalaryHandler(SimpleHTTPRequestHandler):
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

        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": content_type,
            },
        )
        upload = form["file"] if "file" in form else None

        if upload is None or not upload.filename:
            self.send_json({"ok": False, "message": "No file received."}, 400)
            return

        filename = upload.filename.lower()
        file_bytes = upload.file.read()

        if not filename.endswith(".docx"):
            self.send_json({
                "ok": False,
                "message": "Auto-reading is available for text-based DOCX files right now. For this file type, enter the values manually.",
            }, 422)
            return

        try:
            text = read_docx_text(file_bytes)
            fields = extract_salary_fields(text)
            applied_count = sum(1 for value in fields.values() if value)
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

