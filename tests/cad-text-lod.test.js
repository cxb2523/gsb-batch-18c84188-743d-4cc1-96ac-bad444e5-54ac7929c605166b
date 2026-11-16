import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer, THEMES, textVisibility } from '../src/cad/renderer.js';
import { Viewport } from '../src/cad/viewport.js';

// ctx 2D de mentira: registra cada método chamado e devolve medida fixa para measureText.
// Os textos de fillText ficam em record.fillTexts para distinguir entidade de rótulos de UI.
function recordingCtx(record) {
    return new Proxy({}, {
        get(target, prop) {
            if (prop in target) return target[prop];
            return (...args) => {
                record.push(prop);
                if (prop === 'fillText') (record.fillTexts ??= []).push(args[0]);
                return prop === 'measureText' ? { width: 50 } : undefined;
            };
        },
        set(target, prop, value) {
            target[prop] = value;
            return true;
        },
    });
}

function makeViewport(scale) {
    const viewport = new Viewport(800, 600);
    viewport.scale = scale;
    viewport.originX = 400;
    viewport.originY = 300;
    return viewport;
}

function makeRenderer(record, scale, extra = {}) {
    return Object.assign(Object.create(Renderer.prototype), {
        ctx: recordingCtx(record),
        viewport: makeViewport(scale),
        theme: THEMES.dark,
    }, extra);
}

const alignedDim = () => ({
    id: 'dim1',
    type: 'dimension',
    kind: 'aligned',
    p1: { x: 0, y: 0 },
    p2: { x: 100, y: 0 },
    linePoint: { x: 50, y: 20 },
});

const insertWithTextAndLine = () => ({
    id: 'ins1',
    type: 'insert',
    name: 'BLOCO',
    layer: '0',
    color: 'bylayer',
    position: { x: 0, y: 0 },
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    definition: {
        basePoint: { x: 0, y: 0 },
        entities: [
            { type: 'line', start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, layer: '0', color: 'bylayer' },
            { type: 'text', text: 'ETIQUETA', height: 2.5, position: { x: 10, y: 5 }, layer: '0', color: 'bylayer' },
        ],
    },
});

test('cota em zoom mínimo omite o texto mas mantém linhas de cota e setas', () => {
    const dim = alignedDim();

    // Zoom extremo: texto de 2.5 unidades vira 0.25px (< 0.75px) e some; a geometria (10px) fica.
    let record = [];
    makeRenderer(record, 0.1, { currentDimStyle: undefined }).drawDimension(dim, { color: '#ffffff', width: 1 });
    assert.ok(record.includes('stroke'), 'linhas de cota/extensão devem ser desenhadas');
    assert.ok(record.includes('fill'), 'setas devem ser desenhadas');
    assert.ok(!record.includes('fillText'), 'glifos não devem ser desenhados abaixo do limiar');
    assert.ok(!record.includes('fillRect'), 'nem placeholder abaixo de 0.75px');

    // Zoom intermediário (2.5px): texto vira placeholder em barras, ainda sem glifos.
    record = [];
    makeRenderer(record, 1, { currentDimStyle: undefined }).drawDimension(dim, { color: '#ffffff', width: 1 });
    assert.ok(record.includes('stroke'), 'linhas de cota continuam');
    assert.ok(record.includes('fillRect'), 'texto da cota vira placeholder (greeking)');
    assert.ok(!record.includes('fillText'), 'glifos só acima de 3.5px');

    // Zoom legível (10px): o texto da cota volta completo.
    record = [];
    makeRenderer(record, 4, { currentDimStyle: undefined }).drawDimension(dim, { color: '#ffffff', width: 1 });
    assert.ok(record.includes('fillText'), 'texto da cota volta ao ampliar');
});

test('texto dentro de bloco some no zoom mínimo e as linhas do bloco continuam', () => {
    const insert = insertWithTextAndLine();
    const doc = { layers: [], entities: [insert] };

    // Zoom extremo: texto do bloco a 0.25px é omitido; a linha de 10px permanece.
    let record = [];
    makeRenderer(record, 0.1, { currentDoc: doc }).drawEntity(insert, { color: '#ffffff', width: 1, alpha: 1 });
    assert.ok(record.includes('lineTo'), 'linha do bloco deve ser desenhada');
    assert.ok(!record.includes('fillText'), 'texto do bloco omitido abaixo do limiar');
    assert.ok(!record.includes('fillRect'), 'sem placeholder abaixo de 0.75px');

    // Zoom legível: texto e linha do bloco aparecem.
    record = [];
    makeRenderer(record, 4, { currentDoc: doc }).drawEntity(insert, { color: '#ffffff', width: 1, alpha: 1 });
    assert.ok(record.includes('lineTo'), 'linha do bloco continua');
    assert.ok(record.includes('fillText'), 'texto do bloco volta ao ampliar');
});

test('filho de bloco em layer oculta continua sendo pulado', () => {
    const insert = insertWithTextAndLine();
    insert.definition.entities[0].layer = 'OCULTA'; // a linha fica em layer desligada
    const doc = { layers: [{ name: 'OCULTA', visible: false, color: 7 }], entities: [insert] };

    const record = [];
    makeRenderer(record, 4, { currentDoc: doc }).drawEntity(insert, { color: '#ffffff', width: 1, alpha: 1 });
    assert.ok(record.includes('fillText'), 'texto em layer visível é desenhado');
    assert.ok(!record.includes('lineTo'), 'linha em layer oculta não é desenhada');
    assert.ok(!record.includes('stroke'), 'nenhum traço da geometria oculta');
});

test('seleção/hover sempre desenha o texto completo, mesmo no zoom mínimo', () => {
    const text = { id: 't1', type: 'text', text: 'SELECIONADO', height: 2.5, position: { x: 0, y: 0 }, layer: '0' };

    // Unidade: drawText com forceDetail ignora o culling e o placeholder (0.25px).
    let record = [];
    makeRenderer(record, 0.1).drawText(text, { color: '#ffffff', forceDetail: true });
    assert.ok(record.includes('fillText'), 'texto em seleção/hover deve ser desenhado por completo');
    assert.ok(!record.includes('fillRect'), 'sem placeholder para seleção/hover');

    // Cota selecionada: forceDetail atravessa drawDimension até o texto.
    record = [];
    makeRenderer(record, 0.1, { currentDimStyle: undefined })
        .drawDimension(alignedDim(), { color: '#ffffff', width: 1, dashed: true, forceDetail: true });
    assert.ok(record.includes('fillText'), 'texto de cota selecionada é desenhado no zoom mínimo');
    assert.ok(record.includes('stroke'), 'linhas da cota continuam');

    // Bloco selecionado: forceDetail atravessa a expansão do insert até o texto filho.
    const insert = insertWithTextAndLine();
    const doc = { layers: [], entities: [insert] };
    record = [];
    makeRenderer(record, 0.1, { currentDoc: doc })
        .drawEntity(insert, { color: '#ffffff', width: 1, dashed: true, forceDetail: true, alpha: 1 });
    assert.ok(record.includes('fillText'), 'texto filho de bloco selecionado é desenhado no zoom mínimo');
});

test('bloco selecionado não é descartado pelo culling sub-pixel do envelope', () => {
    // Bloco de 1x1 unidade a 0.1px/unidade: envelope de 0.1px seria descartado inteiro.
    const insert = insertWithTextAndLine();
    insert.definition.entities = [
        { type: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, layer: '0', color: 'bylayer' },
    ];
    const doc = { layers: [], entities: [insert] };

    let record = [];
    makeRenderer(record, 0.1, { currentDoc: doc }).drawEntity(insert, { color: '#ffffff', width: 1, alpha: 1 });
    assert.ok(!record.includes('lineTo'), 'sem seleção, bloco sub-pixel é descartado');

    record = [];
    makeRenderer(record, 0.1, { currentDoc: doc })
        .drawEntity(insert, { color: '#ffffff', width: 1, dashed: true, forceDetail: true, alpha: 1 });
    assert.ok(record.includes('lineTo'), 'bloco em seleção/hover é desenhado mesmo sub-pixel');
});

test('draw() marca seleção e hover como forceDetail e não descarta o texto no zoom mínimo', () => {
    const text = { id: 't1', type: 'text', text: 'SELECIONADO', height: 2.5, position: { x: 0, y: 0 }, layer: '0' };
    const doc = { layers: [], entities: [text] };
    const draw = (state) => {
        const record = [];
        makeRenderer(record, 0.1, { dpr: 1, webglSurface: null }).draw({ showGrid: false, ...state });
        return record;
    };

    let record = draw({ doc, selection: new Set(['t1']), hover: null });
    assert.ok(record.fillTexts?.includes('SELECIONADO'), 'texto selecionado é desenhado mesmo sub-pixel');

    record = draw({ doc, selection: new Set(), hover: 't1' });
    assert.ok(record.fillTexts?.includes('SELECIONADO'), 'texto em hover é desenhado mesmo sub-pixel');

    record = draw({ doc, selection: new Set(), hover: null });
    assert.ok(!record.fillTexts?.includes('SELECIONADO'), 'texto solto sub-pixel é descartado');
});

test('altura exatamente no limiar conta como visível', () => {
    // Regra unitária.
    assert.equal(textVisibility(0.75), 'placeholder', '0.75px exatos é visível');
    assert.equal(textVisibility(3.5), 'full', '3.5px exatos é texto completo');
    assert.equal(textVisibility(0.7499), 'hidden', 'abaixo de 0.75px some');
    assert.equal(textVisibility(0.1, { forceDetail: true }), 'full', 'seleção/hover sempre completo');

    // Na prática: height 0.75 * scale 1 = 0.75px exatos → placeholder desenhado.
    const text = { id: 't2', type: 'text', text: 'LIMIAR', height: 0.75, position: { x: 0, y: 0 }, layer: '0' };
    let record = [];
    makeRenderer(record, 1).drawText(text, { color: '#ffffff' });
    assert.ok(record.includes('fillRect'), 'no limiar de 0.75px o texto é visível (placeholder)');
    assert.ok(!record.includes('fillText'));

    // E 3.5px exatos → glifos.
    record = [];
    makeRenderer(record, 1).drawText({ ...text, height: 3.5 }, { color: '#ffffff' });
    assert.ok(record.includes('fillText'), 'no limiar de 3.5px o texto é desenhado completo');
});
