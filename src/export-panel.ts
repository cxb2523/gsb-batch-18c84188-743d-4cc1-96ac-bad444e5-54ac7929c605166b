import { Button, Panel, Container } from '@playcanvas/pcui';
import type { PanelArgs } from '@playcanvas/pcui';
import type { Texture, WebglGraphicsDevice } from 'playcanvas';
import { RenderTarget } from 'playcanvas';

import { HdrExporter } from './hdr-exporter';
import { removeExtension } from './helpers';
import { PngExporter } from './png-exporter';
import type { TextureManager } from './texture-manager';
import { WebpExporter } from './webp-exporter';

type Exporter = {
    run(words: Uint32Array, width: number, height: number): Promise<Uint8Array> | Uint8Array;
    extension: string;
};

type ExportFormat = 'png' | 'webp' | 'hdr';

// everything needed to export a texture, captured when the export is started so
// that switching or closing the selection mid-export cannot change the result
type ExportSnapshot = {
    texture: Texture;
    filename: string;
    cubemap: boolean;
    width: number;
    height: number;
};

type ExportTask = {
    button: Button;
    exporter: Exporter;
    label: string;
    busy: boolean;
};

const readPixels = (texture: Texture, face: number | null, width: number, height: number): Uint32Array => {
    const rt = new RenderTarget({ colorBuffer: texture, depth: false, face: face ?? undefined });
    const data = new Uint8ClampedArray(width * height * 4);
    const device = texture.device as WebglGraphicsDevice;
    const gl = device.gl;

    device.setFramebuffer(rt.impl._glFrameBuffer);
    device.initRenderTarget(rt);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);

    rt.destroy();

    return new Uint32Array(data.buffer);
};

// download the data uri
const download = (filename: string, data: Uint8Array): void => {
    const blob = new Blob([data.buffer as ArrayBuffer], { type: 'octet/stream' });
    const url = window.URL.createObjectURL(blob);

    const lnk = document.createElement('a');
    lnk.download = filename;
    lnk.href = url;

    lnk.click();

    window.URL.revokeObjectURL(url);
};

class TextureExportPanel extends Panel {
    constructor(textureManager: TextureManager, args: PanelArgs = {}) {
        Object.assign(args, {
            id: 'texture-export-pane',
            headerText: 'Export',
            collapsible: true,
            flexGrow: '1'
        });

        super(args);

        const tasks = new Map<ExportFormat, ExportTask>();

        const addExportTask = (format: ExportFormat, label: string, exporter: Exporter): ExportTask => {
            const button = new Button({
                class: 'inspector-button',
                text: label,
                icon: 'E228',
                enabled: false
            });

            const container = new Container({
                class: 'inspector-button-container'
            });
            container.append(button);
            this.append(container);

            const task: ExportTask = {
                button,
                exporter,
                label,
                busy: false
            };
            tasks.set(format, task);

            button.on('click', () => {
                void startExport(format);
            });

            return task;
        };

        addExportTask('png', 'EXPORT TO PNG', new PngExporter());
        addExportTask('webp', 'EXPORT TO WEBP', new WebpExporter());
        addExportTask('hdr', 'EXPORT TO HDR', new HdrExporter());

        // derive the panel and button state from the currently selected texture.
        // buttons with an export in flight stay disabled so the same export
        // cannot be started twice, regardless of the current selection.
        const updateUi = (): void => {
            const texture = textureManager.selectedTextureDoc?.resource ?? null;
            const hasTexture = !!texture;

            tasks.forEach((task, format) => {
                const supported = hasTexture && (format !== 'hdr' || texture!.encoding === 'rgbe');
                task.button.enabled = supported && !task.busy;
            });

            this.enabled = hasTexture;
        };

        const doExport = async (exporter: Exporter, snapshot: ExportSnapshot): Promise<void> => {
            const { texture, filename, cubemap, width, height } = snapshot;

            if (cubemap) {
                const faceNames = ['posx', 'negx', 'posy', 'negy', 'posz', 'negz'];
                for (let face = 0; face < 6; ++face) {
                    download(
                        `${removeExtension(filename)}_${faceNames[face]}.${exporter.extension}`,
                        await exporter.run(readPixels(texture, face, width, height), width, height)
                    );
                }
            } else {
                download(
                    `${removeExtension(filename)}.${exporter.extension}`,
                    await exporter.run(readPixels(texture, null, width, height), width, height)
                );
            }
        };

        const startExport = async (format: ExportFormat): Promise<void> => {
            const task = tasks.get(format)!;

            // ignore repeated clicks while this export is already running
            if (task.busy) {
                return;
            }

            const textureDoc = textureManager.selectedTextureDoc;
            const texture = textureDoc?.resource;
            if (!texture) {
                return;
            }

            // HDR export only works on rgbe-encoded textures
            if (format === 'hdr' && texture.encoding !== 'rgbe') {
                return;
            }

            // capture the export inputs now, so later selection changes cannot
            // leak into the pixels or the filenames of this export
            const snapshot: ExportSnapshot = {
                texture,
                filename: textureDoc.filename,
                cubemap: !!texture.cubemap,
                width: texture.width,
                height: texture.height
            };

            task.busy = true;
            task.button.dom.classList.add('busy-anim');
            task.button.text = 'BUSY...';
            updateUi();

            try {
                await doExport(task.exporter, snapshot);
            } catch (err) {
                console.error(err);
            } finally {
                // only restore this export's own button, and compute its
                // enabled state from the selection that is current now (which
                // may differ from the one that started the export)
                task.busy = false;
                task.button.dom.classList.remove('busy-anim');
                task.button.text = task.label;
                updateUi();
            }
        };

        textureManager.on('textureDocSelected', () => {
            updateUi();
        });

        updateUi();
    }
}

export { TextureExportPanel };
