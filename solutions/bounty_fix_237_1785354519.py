#!/usr/bin/env python3
"""
Dynamic man page generator for taskferry.
Extracts CLI metadata directly from click/argparse CLI definitions to create man pages.
"""

import datetime
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


def escape_roff(text: str) -> str:
    """Escape special roff/troff characters."""
    if not text:
        return ""
    text = text.replace("\\", "\\\\")
    text = text.replace("-", "\\-")
    return text


def generate_roff_from_click(cmd, name="taskferry") -> str:
    """Generate roff formatted string from a Click command or group."""
    import click

    date_str = datetime.date.today().strftime("%Y-%m-%d")
    out = []

    out.append(f'.TH "{name.upper()}" "1" "{date_str}" "{name}" "User Commands"')

    summary = cmd.short_help or (
        cmd.help.strip().split("\n")[0] if cmd.help else "Taskferry CLI tool"
    )
    out.append(".SH NAME")
    out.append(f"{name} \\- {escape_roff(summary)}")

    out.append(".SH SYNOPSIS")
    out.append(
        f"\\fB{name}\\fR [\\fIOPTIONS\\fR] [\\fICOMMAND\\fR] [\\fIARGS\\fR]..."
    )

    if cmd.help:
        out.append(".SH DESCRIPTION")
        for line in cmd.help.strip().split("\n"):
            line_str = line.strip()
            if not line_str:
                out.append(".PP")
            else:
                out.append(escape_roff(line_str))

    ctx = click.Context(cmd)
    options = [
        p for p in cmd.get_params(ctx) if isinstance(p, click.Option)
    ]
    if options:
        out.append(".SH OPTIONS")
        for opt in options:
            opts_str = ", ".join(opt.opts + opt.secondary_opts)
            out.append(".TP")
            out.append(f"\\fB{escape_roff(opts_str)}\\fR")
            if opt.help:
                out.append(escape_roff(opt.help))

    if isinstance(cmd, click.Group):
        out.append(".SH COMMANDS")
        for sub_name, sub_cmd in sorted(cmd.commands.items()):
            if getattr(sub_cmd, "hidden", False):
                continue
            sub_summary = sub_cmd.short_help or (
                sub_cmd.help.strip().split("\n")[0] if sub_cmd.help else ""
            )
            out.append(".TP")
            out.append(f"\\fB{escape_roff(sub_name)}\\fR")
            out.append(escape_roff(sub_summary))

    out.append('.SH "REPORTING BUGS"')
    out.append("Report bugs to the taskferry issue tracker.")

    out.append('.SH "SEE ALSO"')
    out.append(f"\\fB{name}\\fR(1)")

    return "\n".join(out) + "\n"


def main():
    try:
        from taskferry.cli import cli as cli_app
    except ImportError:
        from taskferry.cli import main as cli_app

    output_dir = PROJECT_ROOT / "docs" / "man" / "man1"
    if len(sys.argv) > 1:
        output_dir = Path(sys.argv[1])

    output_dir.mkdir(parents=True, exist_ok=True)
    man_path = output_dir / "taskferry.1"

    roff_content = generate_roff_from_click(cli_app, name="taskferry")

    man_path.write_text(roff_content, encoding="utf-8")
    print(f"Successfully generated man page: {man_path}")


if __name__ == "__main__":
    main()