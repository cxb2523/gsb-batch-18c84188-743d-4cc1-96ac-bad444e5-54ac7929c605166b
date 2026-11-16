import { LfoShape, modulation } from "$library/modulation";

import { defineWorklet } from "../lib/defineWorklet";

export default await defineWorklet({
  name: 'LFO',
  params: {
    rate: {
      defaultValue: 1
    },
    depth: {
      defaultValue: 1
    },
    offset: {
      defaultValue: 0
    },
    phase: {
      defaultValue: 0
    },
    sync: {
      defaultValue: 0
    },
    // 0 — прежнее нерепродуцируемое поведение на Math.random();
    // ненулевое зерно полностью определяет последовательность S&H
    seed: {
      defaultValue: 0
    },
  },
  functions: modulation,
  props: {
    shape: 'sine',
  } as { shape: LfoShape; },
  context: {
    phase: 0,
    sync: 0,
    held: 0,
    // Зерно, под которое инициализирован rng; смена значения (и [RESET])
    // запускает последовательность заново
    curSeed: 0,
    // Текущее 32-битное состояние детерминированного ГПСЧ
    rng: 0,
    // Состояние ещё не инициализировалось на этом жизненном цикле
    started: false as boolean,
  },
  options: {
    numberOfInputs: 0,
    numberOfOutputs: 1
  },
  loop(outL) {
    var f = this.functions;
    var c = this.context;
    var shape = this.props.shape;

    // Следующая ступень S&H: из зерна — детерминированно, иначе через Math.random()
    var draw = () => {
      if (c.curSeed !== 0) {
        c.rng = f.randomNext(c.rng);
        c.held = f.randomUnit(c.rng) * 2 - 1;
      } else {
        c.held = Math.random() * 2 - 1;
      }
    };

    for (var i = 0; i < this.numFrames; i++) {
      var rate = this.param('rate', i);
      var depth = this.param('depth', i);
      var offset = this.param('offset', i);
      var phase = this.param('phase', i);
      var sync = this.param('sync', i);
      var seed = this.param('seed', i);

      // Первая инициализация или смена зерна: последовательность начинается с начала
      if (!c.started || c.curSeed !== seed) {
        c.curSeed = seed;
        c.rng = f.seedRandom(seed);
        draw();
        c.started = true;
      }

      // Фронт sync сбрасывает фазу на этом же сэмпле и сразу берёт новую ступень
      if (f.rising(c.sync, sync)) {
        c.phase = 0;
        draw();
      }

      c.sync = sync;

      outL[i] = offset + depth * f.lfoShape(shape, c.phase + phase, c.held);

      var inc = rate / this.sampleRate;

      // S&H: новое значение на каждом новом периоде
      if (f.lfoWrapped(c.phase, inc, phase))
        draw();

      c.phase = f.wrap(c.phase + inc);
    }
  }
});
