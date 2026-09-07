import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('nodes/catalog.json', root), 'utf8'));
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const scripts = `<script type="text/javascript">
(function() {
  const catalog = ${JSON.stringify(catalog)};
  const validators = {
    json: function(value) { try { JSON.parse(value); return true; } catch { return false; } },
    number: function(value) { return value !== '' && Number.isInteger(Number(value)) && Number(value) >= 0; },
    'optional-number': function(value) { return value == null || value === '' || (Number.isInteger(Number(value)) && Number(value) >= 0); },
    expression: function(value) { return typeof value === 'string' && /^\\{%[\\s\\S]+%\\}$/.test(value); }
  };
  catalog.forEach(function(item) {
    const defaults = { name: { value: '' } };
    item.fields.forEach(function(field) {
      defaults[field.key] = { value: field.default, required: field.format !== 'optional-number' };
      if (validators[field.format]) defaults[field.key].validate = function(value) {
        if (item.type === 'rsl-source' && ((field.key === 'values' && this.sourceKind === 'interval') || (field.key === 'count' && this.sourceKind === 'values'))) return true;
        return validators[field.format](value);
      };
    });
    RED.nodes.registerType(item.type, {
      category: item.category, color: item.color, defaults: defaults,
      inputs: item.inputs, outputs: item.outputs, icon: item.icon, paletteLabel: item.label,
      label: function() { return this.name || (item.type === 'rsl-input' ? this.port : item.label); },
      inputLabels: 'stream', outputLabels: 'stream',
      oneditprepare: function() {
        if (item.type !== 'rsl-source') return;
        const updateSourceFields = function() {
          const interval = $('#node-input-sourceKind').val() === 'interval';
          $('#node-input-values').closest('.form-row').toggle(!interval);
          $('#node-input-valueType').closest('.form-row').toggle(!interval);
          $('#node-input-count').closest('.form-row').toggle(interval);
        };
        $('#node-input-sourceKind').on('change', updateSourceFields);
        updateSourceFields();
      },
      onpaletteadd: function() { if (window.RslPanel) window.RslPanel.install(); }
    });
  });
})();
</script>`;
const dialogs = catalog.map(item => {
  const fields = [{ key: 'name', label: 'Name' }, ...item.fields];
  const form = fields.map(field => {
    const id = 'node-input-' + field.key;
    const control = field.choices ? `<select id="${id}">${field.choices.map(choice => `<option value="${escape(choice)}">${escape(choice)}</option>`).join('')}</select>` : `<input type="${field.format?.includes('number') ? 'number' : 'text'}" id="${id}" ${field.format?.includes('number') ? 'min="0" step="1"' : ''} style="width:70%">`;
    return `<div class="form-row"><label for="${id}">${escape(field.label)}</label>${control}</div>`;
  }).join('\n');
  return `<script type="text/html" data-template-name="${item.type}">${form}<p>${escape(item.help)}</p></script>\n<script type="text/html" data-help-name="${item.type}"><p>${escape(item.help)}</p></script>`;
}).join('\n');
await writeFile(new URL('nodes/rsl.html', root), '<!-- Generated from catalog.json by scripts/generate-nodes.mjs -->\n' + scripts + '\n' + dialogs + '\n');
