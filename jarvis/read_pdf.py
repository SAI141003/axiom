"""Fetch a PDF and print its text (first N chars). Used by JARVIS's read_url for PDFs."""
import sys, urllib.request, io
import fitz  # PyMuPDF
url, limit = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 16000
data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=40).read()
doc = fitz.open(stream=io.BytesIO(data), filetype="pdf")
out = []
for page in doc:
    out.append(page.get_text())
    if sum(len(x) for x in out) > limit: break
print(" ".join(" ".join(out).split())[:limit])
