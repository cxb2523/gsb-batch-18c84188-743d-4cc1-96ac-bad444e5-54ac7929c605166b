/**
 * Testes do jogo da cobrinha.
 *
 * Este arquivo é compartilhado entre dois ambientes:
 *  - navegador (`test/test.html`, via Mocha);
 *  - Node.js (`test/snake.test.js`, via `node --test`), usando `node:test`.
 *
 * As classes testadas são recebidas por parâmetro para que a mesma suíte
 * rode nos dois ambientes sem depender de globais.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory;
    } else {
        factory(root.__snakeTestContext || {});
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function (context) {
    "use strict";

    const isNode = typeof module === "object" && module !== null && !!module.exports;

    let describe;
    let it;
    if (isNode) {
        const nodeTest = require("node:test");
        describe = nodeTest.describe;
        it = nodeTest.it;
    } else {
        describe = globalThis.describe;
        it = globalThis.it;
    }

    /** Comparação simples e independente de biblioteca de asserção. */
    function expectEqual(actual, expected, message) {
        if (actual !== expected) {
            throw new Error(`${message || "valor inesperado"}: esperado ${String(expected)}, recebido ${String(actual)}`);
        }
    }

    function expectDeepEqual(actual, expected, message) {
        const actualJson = JSON.stringify(actual);
        const expectedJson = JSON.stringify(expected);
        if (actualJson !== expectedJson) {
            throw new Error(`${message || "valor inesperado"}: esperado ${expectedJson}, recebido ${actualJson}`);
        }
    }

    function expectTrue(value, message) {
        if (!value) {
            throw new Error(message || "esperava true");
        }
    }

    function expectFalse(value, message) {
        if (value) {
            throw new Error(message || "esperava false");
        }
    }

    /** Contexto 2D falso: registra chamadas sem depender do canvas real. */
    function createFakeContext() {
        const calls = [];
        const record = (name) => (...args) => calls.push({ name, args });
        return {
            calls,
            clearRect: record("clearRect"),
            fillRect: record("fillRect"),
            beginPath: record("beginPath"),
            moveTo: record("moveTo"),
            lineTo: record("lineTo"),
            stroke: record("stroke"),
            set fillStyle(value) {
                calls.push({ name: "fillStyle", args: [value] });
            },
            set strokeStyle(value) {
                calls.push({ name: "strokeStyle", args: [value] });
            },
            set lineWidth(value) {
                calls.push({ name: "lineWidth", args: [value] });
            },
        };
    }

    function createWorld(WorldClass, overrides) {
        const settings = Object.assign(
            { width: 400, height: 400, cellSize: 20 },
            overrides || {},
        );
        const canvas = { width: settings.width, height: settings.height };
        return new WorldClass(
            settings.width,
            settings.height,
            settings.cellSize,
            createFakeContext(),
            canvas,
        );
    }

    /** Fonte aleatória determinística, em ciclo, sempre em [0, 1). */
    function createRandomSource(values) {
        let index = 0;
        return function () {
            const value = values[index % values.length];
            index += 1;
            return value;
        };
    }

    function createFakeElement() {
        const classes = new Set();
        return {
            textContent: "",
            hidden: false,
            classes,
            classList: {
                add(name) {
                    classes.add(name);
                },
                remove(name) {
                    classes.delete(name);
                },
            },
        };
    }

    function createGameHarness(classes, options) {
        const { SnakeGame, GAME_CONFIG } = classes;
        const settings = options || {};
        const scoreElement = createFakeElement();
        const overlayElement = createFakeElement();
        overlayElement.hidden = true;
        const overlayTitleElement = createFakeElement();
        const finalScoreElement = createFakeElement();
        const beep = { playCount: 0, play() { this.playCount += 1; } };
        const listeners = {};
        const eventTarget = {
            addEventListener(type, handler) {
                listeners[type] = handler;
            },
        };
        // Agendador falso: o loop não mantém o processo vivo nos testes.
        const timers = new Map();
        let nextTimerId = 1;
        const scheduler = {
            setInterval(callback) {
                const id = nextTimerId++;
                timers.set(id, callback);
                return id;
            },
            clearInterval(id) {
                timers.delete(id);
            },
        };

        const game = new SnakeGame({
            canvas: { width: 400, height: 400 },
            context: createFakeContext(),
            scoreElement,
            overlayElement,
            overlayTitleElement,
            finalScoreElement,
            beepSound: beep,
            randomSource: settings.randomSource || createRandomSource([0.25]),
            eventTarget,
            scheduler,
            tickIntervalMs: GAME_CONFIG.tickIntervalMs,
        });

        return {
            game,
            scoreElement,
            overlayElement,
            overlayTitleElement,
            finalScoreElement,
            beep,
            listeners,
            timers,
            scheduler,
        };
    }

    function allCells(columns, rows, boxSize) {
        const cells = [];
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                cells.push({ x: column * boxSize, y: row * boxSize });
            }
        }
        return cells;
    }

    function testSnake(classes) {
        const { Snake } = classes;

        describe("Snake: teletransporte pelas bordas", () => {
            it("deve continuar o corpo no lado oposto ao cruzar a borda direita", () => {
                const world = createWorld(classes.World);
                const snake = new Snake(world);
                snake.size = 3;
                snake.positionX = 380;
                snake.positionY = 0;
                snake.direction = classes.DIRECTION.RIGHT;
                snake.lastDirection = classes.DIRECTION.RIGHT;
                snake.tail = [
                    { x: 340, y: 0 },
                    { x: 360, y: 0 },
                    { x: 380, y: 0 },
                ];

                snake.drawSnake();

                expectEqual(snake.positionX, 0, "cabeça deveria reaparecer em x=0");
                expectEqual(snake.positionY, 0, "y não deveria mudar");
                // Corpo contínuo: 360 -> 380 -> 0 (uma célula por passo).
                expectDeepEqual(snake.tail, [
                    { x: 360, y: 0 },
                    { x: 380, y: 0 },
                    { x: 0, y: 0 },
                ]);
                const allInside = snake.tail.every(
                    (cell) => cell.x >= 0 && cell.x < world.canvasWidth
                        && cell.y >= 0 && cell.y < world.canvasHeight,
                );
                expectTrue(allInside, "nenhum segmento pode ficar fora do canvas");
            });

            it("deve atravessar as bordas esquerda, superior e inferior", () => {
                const world = createWorld(classes.World);
                const snake = new Snake(world);

                const cases = [
                    { x: 0, y: 200, direction: classes.DIRECTION.LEFT, expectedX: 380, expectedY: 200 },
                    { x: 200, y: 0, direction: classes.DIRECTION.UP, expectedX: 200, expectedY: 380 },
                    { x: 200, y: 380, direction: classes.DIRECTION.DOWN, expectedX: 200, expectedY: 0 },
                ];

                cases.forEach((item) => {
                    snake.positionX = item.x;
                    snake.positionY = item.y;
                    snake.direction = item.direction;
                    snake.lastDirection = item.direction;
                    snake.size = 1;
                    snake.tail = [{ x: item.x, y: item.y }];
                    snake.isGameOver = false;

                    snake.drawSnake();

                    expectEqual(snake.positionX, item.expectedX, `x após ${item.direction}`);
                    expectEqual(snake.positionY, item.expectedY, `y após ${item.direction}`);
                });
            });

            it("não deve colidir consigo mesma ao cruzar a borda sem tocar o corpo", () => {
                const world = createWorld(classes.World);
                const snake = new Snake(world);
                snake.size = 3;
                snake.positionX = 380;
                snake.positionY = 0;
                snake.direction = classes.DIRECTION.RIGHT;
                snake.lastDirection = classes.DIRECTION.RIGHT;
                snake.tail = [
                    { x: 340, y: 100 },
                    { x: 360, y: 100 },
                    { x: 380, y: 0 },
                ];

                snake.drawSnake();

                expectFalse(snake.isGameOver, "não houve colisão real");
            });

            it("wrapCoordinate deve normalizar qualquer coordenada para a grade", () => {
                const world = createWorld(classes.World);
                const snake = new Snake(world);
                const boxSize = world.boxSizeInPx;

                const cases = [
                    // [entrada, limite, esperado]
                    [400, 400, 0],
                    [420, 400, 20],
                    [-20, 400, 380],
                    [-40, 400, 360],
                    [800, 400, 0],
                    [381, 400, 380],
                    [399, 400, 380],
                    [0, 400, 0],
                    [380, 400, 380],
                ];

                cases.forEach(([input, limit, expected]) => {
                    const result = snake.wrapCoordinate(input, limit);
                    expectEqual(result, expected, `wrap(${input})`);
                    expectEqual(result % boxSize, 0, `wrap(${input}) deveria ficar alinhado`);
                    expectTrue(result >= 0 && result < limit, `wrap(${input}) deveria ficar no tabuleiro`);
                });
            });

            it("deve chegar ao lado oposto em passos sucessivos, sem deixar buraco", () => {
                // O caso real: duas células contíguas na borda devem manter a
                // distância de exatamente um quadradinho após a volta.
                const world = createWorld(classes.World);
                const snake = new Snake(world);
                snake.size = 2;
                snake.positionX = 380;
                snake.positionY = 0;
                snake.direction = classes.DIRECTION.RIGHT;
                snake.lastDirection = classes.DIRECTION.RIGHT;
                snake.tail = [
                    { x: 360, y: 0 },
                    { x: 380, y: 0 },
                ];

                snake.drawSnake();

                const head = snake.tail[snake.tail.length - 1];
                const neck = snake.tail[snake.tail.length - 2];
                expectEqual(snake.tail.length, 2, "corpo deveria manter o tamanho");
                // Vizinhança considerando a volta: 380 -> 0 é um passo de 20px.
                const distance = Math.abs(head.x - neck.x) === world.boxSizeInPx
                    || Math.abs(head.x - neck.x) === world.canvasWidth - world.boxSizeInPx;
                expectTrue(distance, "segmentos deveriam permanecer vizinhos");
                expectEqual(neck.x, 380, "segmento anterior deveria continuar na borda");
                expectEqual(head.x, 0, "cabeça deveria aparecer no lado oposto");
            });

            it("não deve mover a cobra depois do fim da partida", () => {
                const world = createWorld(classes.World);
                const snake = new Snake(world);
                snake.direction = classes.DIRECTION.RIGHT;
                snake.lastDirection = classes.DIRECTION.RIGHT;
                snake.positionX = 40;
                snake.positionY = 0;
                snake.tail = [{ x: 40, y: 0 }];
                snake.gameOver();

                snake.drawSnake();
                snake.drawSnake();

                expectEqual(snake.positionX, 40, "posição não deveria mudar");
                expectEqual(snake.positionY, 0);
            });
        });

        describe("Snake: colisão com o próprio corpo", () => {
            it("deve detectar colisão usando a posição real após atravessar a borda", () => {
                const world = createWorld(classes.World);
                const snake = new Snake(world);
                snake.size = 5;
                snake.positionX = 380;
                snake.positionY = 0;
                snake.direction = classes.DIRECTION.RIGHT;
                snake.lastDirection = classes.DIRECTION.RIGHT;
                // A cabeça avança para x=400, dá a volta e cai em (0,0),
                // que já está ocupado pelo corpo.
                snake.tail = [
                    { x: 60, y: 0 },
                    { x: 0, y: 0 },
                    { x: 100, y: 0 },
                    { x: 120, y: 0 },
                    { x: 380, y: 0 },
                ];

                snake.drawSnake();

                expectEqual(snake.positionX, 0, "cabeça deveria estar no lado oposto");
                expectTrue(snake.isGameOver, "deveria detectar a colisão no lado oposto");
            });

            it("não deve acusar colisão ao entrar na célula que a cauda acabou de desocupar", () => {
                const world = createWorld(classes.World);
                const snake = new Snake(world);
                snake.size = 6;
                snake.positionX = 40;
                snake.positionY = 20;
                snake.direction = classes.DIRECTION.RIGHT;
                snake.lastDirection = classes.DIRECTION.RIGHT;
                // A cauda em (60,20) será desocupada neste passo.
                snake.tail = [
                    { x: 60, y: 20 },
                    { x: 60, y: 0 },
                    { x: 40, y: 0 },
                    { x: 20, y: 0 },
                    { x: 20, y: 20 },
                    { x: 40, y: 20 },
                ];

                snake.drawSnake();

                expectEqual(snake.positionX, 60, "cabeça deveria avançar para a célula da cauda");
                expectFalse(snake.isGameOver, "a célula desocupada pela cauda é válida");
            });

            it("deve manter a proibição de meia-volta", () => {
                const world = createWorld(classes.World);
                const snake = new Snake(world);
                snake.direction = classes.DIRECTION.LEFT;
                snake.lastDirection = classes.DIRECTION.RIGHT;

                snake.filterDirection();

                expectEqual(snake.direction, classes.DIRECTION.RIGHT, "meia-volta deveria ser bloqueada");
                expectEqual(snake.lastDirection, classes.DIRECTION.RIGHT);
            });
        });

        describe("Snake: células ocupadas", () => {
            it("deve listar corpo e cabeça sem repetir", () => {
                const world = createWorld(classes.World);
                const snake = new Snake(world);
                snake.positionX = 40;
                snake.positionY = 0;
                snake.tail = [
                    { x: 0, y: 0 },
                    { x: 20, y: 0 },
                    { x: 40, y: 0 },
                ];

                expectDeepEqual(snake.getOccupiedCells(), [
                    { x: 0, y: 0 },
                    { x: 20, y: 0 },
                    { x: 40, y: 0 },
                ]);
            });
        });
    }

    function testFood(classes) {
        const { Food } = classes;

        describe("Food: sorteio de posição", () => {
            it("nunca deve sortear uma célula ocupada pela cobra", () => {
                const world = createWorld(classes.World);
                const occupied = [
                    { x: 0, y: 0 },
                    { x: 20, y: 0 },
                    { x: 40, y: 0 },
                    { x: 60, y: 0 },
                ];
                const randomValues = [0, 0.1, 0.25, 0.5, 0.75, 0.99];
                const food = new Food(world, createRandomSource(randomValues));

                for (let attempt = 0; attempt < 200; attempt++) {
                    const position = food.generateRandomFoodPosition(occupied);
                    expectTrue(position !== null, "deveria existir posição livre");
                    const isOccupied = occupied.some(
                        (cell) => cell.x === position.x && cell.y === position.y,
                    );
                    expectFalse(isOccupied, `sorteou célula ocupada (${position.x}, ${position.y})`);
                }
            });

            it("deve alinhar a posição à grade e mantê-la dentro do canvas", () => {
                const world = createWorld(classes.World);
                const food = new Food(world, createRandomSource([0, 0.3333, 0.5, 0.9999]));

                for (let attempt = 0; attempt < 50; attempt++) {
                    const position = food.generateRandomFoodPosition([]);
                    expectEqual(position.x % world.boxSizeInPx, 0, "x alinhado à grade");
                    expectEqual(position.y % world.boxSizeInPx, 0, "y alinhado à grade");
                    expectTrue(position.x >= 0 && position.x < world.canvasWidth, "x dentro do canvas");
                    expectTrue(position.y >= 0 && position.y < world.canvasHeight, "y dentro do canvas");
                }
            });

            it("deve escolher a única célula livre quando quase todo o tabuleiro está ocupado", () => {
                const world = createWorld(classes.World);
                const all = allCells(20, 20, world.boxSizeInPx);
                const onlyFree = { x: 300, y: 360 };
                const occupied = all.filter(
                    (cell) => !(cell.x === onlyFree.x && cell.y === onlyFree.y),
                );
                const food = new Food(world, createRandomSource([0]));

                const position = food.generateRandomFoodPosition(occupied);

                expectDeepEqual(position, onlyFree);
                expectTrue(food.hasPosition, "deveria haver posição válida");
            });

            it("deve informar 'sem posição' quando o tabuleiro está cheio, sem travar", () => {
                const world = createWorld(classes.World);
                const occupied = allCells(20, 20, world.boxSizeInPx);
                const food = new Food(world, createRandomSource([0.5]));

                const position = food.generateRandomFoodPosition(occupied);

                expectEqual(position, null, "tabuleiro cheio deveria retornar null");
                expectFalse(food.hasPosition, "não deveria marcar posição válida");
            });

            it("isColliding não deve mais sortear uma nova posição", () => {
                const world = createWorld(classes.World);
                const food = new Food(world, createRandomSource([0.5]));
                food.positionX = 40;
                food.positionY = 60;
                food.hasPosition = true;

                expectTrue(food.isColliding(40, 60), "deveria detectar colisão");
                expectEqual(food.positionX, 40, "posição não deveria mudar");
                expectEqual(food.positionY, 60, "posição não deveria mudar");
                expectFalse(food.isColliding(0, 0), "não deveria detectar colisão");
            });
        });
    }

    function testGame(classes) {
        const { GAME_STATE } = classes;

        describe("SnakeGame: fim de partida", () => {
            it("deve parar o loop, preservar a pontuação e exibir Game Over", () => {
                const harness = createGameHarness(classes);
                const { game } = harness;
                game.start();

                // Monta uma colisão real: a cabeça (80,80) anda para (60,80),
                // que já pertence ao corpo. A cauda que será desocupada está
                // em outra célula, então a colisão não é "entrar na cauda".
                game.snake.positionX = 80;
                game.snake.positionY = 80;
                game.snake.size = 4;
                game.snake.direction = classes.DIRECTION.LEFT;
                game.snake.lastDirection = classes.DIRECTION.LEFT;
                game.snake.tail = [
                    { x: 0, y: 80 },
                    { x: 60, y: 80 },
                    { x: 40, y: 80 },
                    { x: 80, y: 80 },
                ];
                harness.scoreElement.textContent = "4";

                game.tick();

                expectEqual(game.state, GAME_STATE.GAME_OVER, "estado deveria ser game over");
                expectFalse(game.isRunning, "o loop deveria parar");
                expectEqual(game.timerId, null, "o intervalo deveria ser liberado");
                expectEqual(harness.overlayElement.hidden, false, "painel deveria aparecer");
                expectTrue(
                    harness.overlayElement.classes.has("is-visible"),
                    "painel deveria estar visível",
                );
                expectEqual(harness.overlayTitleElement.textContent, "Game Over");
                expectEqual(harness.finalScoreElement.textContent, "4", "pontuação final preservada");
                expectEqual(harness.scoreElement.textContent, "4", "placar não pode ser zerado");
                expectEqual(harness.timers.size, 0, "nenhum temporizador deveria restar");
            });

            it("não deve alterar a direção após o fim da partida", () => {
                const harness = createGameHarness(classes);
                const { game } = harness;
                game.start();
                game.finishGame(GAME_STATE.GAME_OVER);
                const previousDirection = game.snake.direction;

                game.onKeyDown({ key: classes.DIRECTION.UP });
                game.onKeyDown({ key: classes.DIRECTION.LEFT });

                expectEqual(game.snake.direction, previousDirection, "teclas deveriam ser ignoradas");
                expectEqual(game.state, GAME_STATE.GAME_OVER);
            });

            it("deve encerrar sem loop quando o tabuleiro não tem células livres", () => {
                const harness = createGameHarness(classes);
                const { game } = harness;
                game.snake.tail = allCells(20, 20, game.world.boxSizeInPx);
                game.snake.positionX = 380;
                game.snake.positionY = 380;
                game.snake.size = 400;

                game.start();

                expectEqual(game.state, GAME_STATE.BOARD_FULL, "estado deveria indicar tabuleiro cheio");
                expectFalse(game.isRunning, "não deveria iniciar o loop");
                expectEqual(game.timerId, null, "nenhum intervalo deveria existir");
                expectEqual(game.food.hasPosition, false, "não há comida válida");
                expectEqual(harness.overlayElement.hidden, false, "painel deveria aparecer");
                expectEqual(harness.finalScoreElement.textContent, "400");
            });
        });

        describe("SnakeGame: alimentação", () => {
            it("deve crescer, pontuar, tocar o som e sortear nova comida fora do corpo", () => {
                const harness = createGameHarness(classes);
                const { game } = harness;
                game.start();

                const nextX = game.snake.positionX + game.world.boxSizeInPx;
                game.food.positionX = nextX;
                game.food.positionY = game.snake.positionY;
                game.food.hasPosition = true;
                const sizeBefore = game.snake.size;

                game.tick();

                expectEqual(game.snake.size, sizeBefore + 1, "a cobra deveria crescer");
                expectEqual(harness.scoreElement.textContent, String(sizeBefore + 1));
                expectEqual(harness.beep.playCount, 1, "o som deveria tocar uma vez");

                const occupied = game.snake.getOccupiedCells();
                const foodIsOccupied = occupied.some(
                    (cell) => cell.x === game.food.positionX && cell.y === game.food.positionY,
                );
                expectFalse(foodIsOccupied, "a nova comida não pode cair no corpo");

                game.stop();
            });

            it("deve sortear a comida inicial fora das células da cobra", () => {
                const harness = createGameHarness(classes, {
                    randomSource: createRandomSource([0, 0.9999, 0.5]),
                });
                const { game } = harness;

                game.start();

                const occupied = game.snake.getOccupiedCells();
                const foodIsOccupied = occupied.some(
                    (cell) => cell.x === game.food.positionX && cell.y === game.food.positionY,
                );
                expectFalse(foodIsOccupied, "comida inicial não pode nascer na cobra");

                game.stop();
            });
        });
    }

    testSnake(context);
    testFood(context);
    testGame(context);
});
