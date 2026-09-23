# AXIOM — IEEE conference paper

`axiom.pdf` (6 pages, IEEE two-column conference format).

Every number and every figure comes from the live desk. Nothing was
transcribed by hand:

    .venv/bin/python paper/figs.py      # pulls /api/journal and /api/fleet, writes the figures
    cd paper && pdflatex axiom.tex && pdflatex axiom.tex

`data.json` is the snapshot the figures were drawn from, so the build is
reproducible after the logs have moved on. Re-run `figs.py` to refresh it.

`IEEEtran.cls` is vendored because it is not in the system TeX tree.
