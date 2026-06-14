import sys
import codecs

with codecs.open('src/components/Modules.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

start_idx = content.find('// ---- LIBRARY ----')
end_idx = content.find('\n//', start_idx + 10)
if end_idx == -1:
    end_idx = len(content)

with codecs.open('../library_patch.tsx', 'r', encoding='utf-8') as f:
    patch_full = f.read()

patch_start = patch_full.find('// ---- LIBRARY ----')
if patch_start != -1:
    patch = patch_full[patch_start:]
else:
    patch = patch_full

new_content = content[:start_idx] + patch + "\n" + content[end_idx:]

with codecs.open('src/components/Modules.tsx', 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Patched Modules.tsx")
