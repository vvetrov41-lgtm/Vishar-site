from pathlib import Path

path = Path('admin/src/test/navigation-shell.test.tsx')
text = path.read_text()
old = "    const contact = screen.getByRole('heading', { level: 2, name: 'Contact submitted with this enquiry' });"
new = "    const contact = screen.getByRole('heading', { level: 2, name: 'Current client details' });"
assert old in text, 'navigation continuity assertion not found'
path.write_text(text.replace(old, new, 1))
