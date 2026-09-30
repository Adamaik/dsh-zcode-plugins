# Academic brief

Use for papers, theses, and any LaTeX source the user already maintains.

## Rules

1. Preserve the user's document class, packages, bibliography system, and macro definitions. Do not migrate to another template.
2. Compile with Tectonic when it is installed:

   ```sh
   tectonic -X compile main.tex --outdir <dir>
   ```

   Tectonic resolves packages over the network on first use; a first compile can be slow. Run it again when a compile reports unresolved references or citations, then check the log.
3. Never hand-edit generated `.aux`, `.bbl`, `.toc`, or index files.
4. Missing citations and undefined references are content bugs: report the exact keys instead of removing them.

## When Tectonic is unavailable

Report that the Academic route needs Tectonic and that installing it is a large download. Ask before installing. Do not substitute a different TeX distribution and do not re-typeset the paper in another route.

## Check before delivery

- The compile log has no unresolved reference, missing citation, or overfull box that clips text.
- Page count and bibliography entries match the source.
- Render the first and last page to PNG and look at them; a clean log does not prove the layout.
