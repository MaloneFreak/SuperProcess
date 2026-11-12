import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { layoutProcess } from '../src/core/layout/layout';
import { validateModel } from '../src/core/model/validate';
import { renderSvg } from '../src/core/render/svg';
import { getTheme } from '../src/core/render/theme';
import { sampleModel, sampleTranscript } from '../src/samples/sample';

const OUT = process.env.SP_RENDER_DIR;

describe('built-in sample', () => {
  for (const language of ['en', 'pt-BR', 'es']) {
    it(`is a clean BPMN model in ${language}`, () => {
      const model = sampleModel(language);
      const validation = validateModel(model);
      expect(validation.issues.filter((i) => i.severity !== 'info'), JSON.stringify(validation.issues)).toHaveLength(0);
      expect(model.language).toBe(language);
      expect(model.nodes).toHaveLength(24);
      expect(model.messageFlows).toHaveLength(5);
      // Every text of the model is filled in.
      for (const node of model.nodes) if (node.type !== 'exclusiveGateway') expect(node.name, node.id).not.toBe('');
      expect(JSON.stringify(model)).not.toContain('undefined');

      const layout = layoutProcess(model);
      expect(Object.keys(layout.nodes)).toHaveLength(24);
      const transcript = sampleTranscript(language);
      expect(transcript.text.split('\n').length).toBeGreaterThan(15);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(`${OUT}/sample-${language}.svg`, renderSvg(model, layout, { theme: getTheme('color') }));
      }
    });
  }

  it('falls back to English for other languages', () => {
    expect(sampleModel('fr').language).toBe('en');
  });
});
