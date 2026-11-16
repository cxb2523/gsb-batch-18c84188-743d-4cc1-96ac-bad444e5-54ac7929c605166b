/**
 * Ponto de entrada do jogo: cria os objetos, escuta o teclado
 * e executa o ciclo principal de atualização e desenho.
 *
 * A classe `SnakeGame` concentra o ciclo e as decisões de fim de partida.
 * Ela é separada da inicialização (`startGame`) para poder ser testada sem
 * depender do DOM real.
 */

/** Teclas que controlam a cobra. */
const CONTROL_KEYS = Object.values(DIRECTION);

/** Estados possíveis de uma partida. */
const GAME_STATE = Object.freeze({
    READY: "ready",
    RUNNING: "running",
    /** A cobra bateu no próprio corpo. */
    GAME_OVER: "game-over",
    /** O tabuleiro ficou sem células livres para a comida. */
    BOARD_FULL: "board-full",
});

class SnakeGame {
    /**
     * @param {object} options
     * @param {HTMLCanvasElement} options.canvas Canvas do jogo.
     * @param {CanvasRenderingContext2D} [options.context] Contexto 2D (opcional).
     * @param {HTMLElement} [options.scoreElement] Elemento que mostra o tamanho.
     * @param {HTMLElement} [options.overlayElement] Painel de fim de jogo.
     * @param {HTMLElement} [options.overlayTitleElement] Título do painel.
     * @param {HTMLElement} [options.finalScoreElement] Pontuação final do painel.
     * @param {{play: function(): void}} [options.beepSound] Som ao comer.
     * @param {function(): number} [options.randomSource] Fonte aleatória.
     * @param {EventTarget} [options.eventTarget] Onde escutar o teclado.
     * @param {{setInterval: function, clearInterval: function}} [options.scheduler]
     *   Agendador do loop. Injetável para testes; usa os temporizadores
     *   globais por padrão.
     */
    constructor(options) {
        this.canvas = options.canvas;
        this.context = options.context || this.canvas.getContext("2d");
        this.scoreElement = options.scoreElement || null;
        this.overlayElement = options.overlayElement || null;
        this.overlayTitleElement = options.overlayTitleElement || null;
        this.finalScoreElement = options.finalScoreElement || null;
        this.beepSound = options.beepSound || { play() {} };
        this.randomSource = options.randomSource || Math.random;
        this.eventTarget = options.eventTarget || document;
        this.tickIntervalMs = options.tickIntervalMs || GAME_CONFIG.tickIntervalMs;
        this.scheduler = options.scheduler || {
            setInterval: (callback, delay) => setInterval(callback, delay),
            clearInterval: (id) => clearInterval(id),
        };

        this.world = new World(
            GAME_CONFIG.canvasWidth,
            GAME_CONFIG.canvasHeight,
            GAME_CONFIG.cellSize,
            this.context,
            this.canvas,
        );
        this.snake = new Snake(this.world);
        this.food = new Food(this.world, this.randomSource);

        /** Estado atual da partida. */
        this.state = GAME_STATE.READY;
        /** `true` enquanto o loop principal estiver ativo. */
        this.isRunning = false;
        /** Identificador do `setInterval` do loop. */
        this.timerId = null;

        this.handleKeyDown = (event) => this.onKeyDown(event);
        this.eventTarget.addEventListener("keydown", this.handleKeyDown);
    }

    /** Inicia a partida e o loop principal. */
    start() {
        if (this.isRunning) {
            return;
        }

        this.state = GAME_STATE.RUNNING;
        this.isRunning = true;
        this.hideOverlay();
        this.updateScore();

        // Sem célula livre não há como jogar: encerra antes de criar o loop.
        if (!this.placeFood()) {
            return;
        }

        this.drawInitialFrame();
        this.timerId = this.scheduler.setInterval(
            () => this.tick(),
            this.tickIntervalMs,
        );
    }

    /** Para o loop principal e libera o identificador do intervalo. */
    stop() {
        this.isRunning = false;
        if (this.timerId !== null) {
            this.scheduler.clearInterval(this.timerId);
            this.timerId = null;
        }
    }

    /** Executa uma atualização completa do jogo. */
    tick() {
        if (!this.isRunning) {
            return;
        }

        this.draw();

        // `draw()` move a cobra; a colisão com o corpo é detectada ali.
        if (this.snake.isGameOver) {
            this.finishGame(GAME_STATE.GAME_OVER);
            return;
        }

        if (this.food.isColliding(this.snake.positionX, this.snake.positionY)) {
            this.eatFood();
            // Se a cobra ocupou o tabuleiro inteiro, a partida termina aqui.
            if (!this.placeFood()) {
                return;
            }
        }
    }

    /** Processa o efeito de comer: crescimento, som, pontuação e nova comida. */
    eatFood() {
        this.snake.eatFood();
        this.playBeep();
        this.updateScore();
    }

    /**
     * Sorteia uma nova comida evitando todas as células ocupadas pela cobra.
     * @returns {boolean} `false` se não existe nenhuma célula livre.
     */
    placeFood() {
        const position = this.food.generateRandomFoodPosition(
            this.snake.getOccupiedCells(),
        );
        if (position) {
            return true;
        }

        this.finishGame(GAME_STATE.BOARD_FULL);
        return false;
    }

    /** Limpa o canvas e redesenha a grade, a comida e a cobra. */
    draw() {
        this.world.clearRect();
        this.world.drawLinesHorizontal();
        this.world.drawLinesVertical();
        this.food.generateFood();
        this.snake.drawSnake();
    }

    /**
     * Desenha o primeiro quadro sem avançar a cobra. Usado ao iniciar a
     * partida, para que a primeira célula já apareça antes do primeiro tick.
     */
    drawInitialFrame() {
        this.world.clearRect();
        this.world.drawLinesHorizontal();
        this.world.drawLinesVertical();
        this.food.generateFood();
        this.snake.drawTail();
        this.snake.drawBox(this.snake.positionX, this.snake.positionY);
    }

    /**
     * Encerra a partida de forma visível: para o loop, mantém a pontuação e
     * exibe o painel de fim de jogo. Não recarrega a página.
     *
     * @param {string} state Um dos estados finais de `GAME_STATE`.
     */
    finishGame(state) {
        if (this.state === GAME_STATE.GAME_OVER || this.state === GAME_STATE.BOARD_FULL) {
            return;
        }

        this.state = state;
        this.snake.gameOver();
        this.stop();
        this.updateScore();
        this.showOverlay(state);
    }

    /** Atualiza o texto da pontuação, sem zerá-la. */
    updateScore() {
        if (!this.scoreElement) {
            return;
        }
        this.scoreElement.textContent = this.snake.size.toString();
    }

    /** Mostra o painel de fim de jogo com a pontuação alcançada. */
    showOverlay(state) {
        if (this.overlayElement) {
            this.overlayElement.hidden = false;
            this.overlayElement.classList.add("is-visible");
        }
        if (this.overlayTitleElement) {
            this.overlayTitleElement.textContent =
                state === GAME_STATE.BOARD_FULL ? "You Win!" : "Game Over";
        }
        if (this.finalScoreElement) {
            this.finalScoreElement.textContent = this.snake.size.toString();
        }
    }

    /** Esconde o painel de fim de jogo. */
    hideOverlay() {
        if (!this.overlayElement) {
            return;
        }
        this.overlayElement.hidden = true;
        this.overlayElement.classList.remove("is-visible");
    }

    /** Toca o som da comida sem deixar uma falha de áudio derrubar o jogo. */
    playBeep() {
        try {
            const result = this.beepSound.play();
            if (result && typeof result.catch === "function") {
                result.catch(() => {});
            }
        } catch (error) {
            // Autoplay bloqueado pelo navegador: o jogo continua sem som.
        }
    }

    /**
     * Aceita setas apenas durante a partida. Depois do fim, as teclas são
     * ignoradas para que a direção não mude.
     */
    onKeyDown(event) {
        if (!this.isRunning || this.state !== GAME_STATE.RUNNING) {
            return;
        }
        if (CONTROL_KEYS.includes(event.key)) {
            this.snake.direction = event.key;
        }
    }
}

/** Cria os objetos do jogo e inicia o ciclo principal. */
function startGame() {
    const canvas = document.getElementById("canvas");
    canvas.width = GAME_CONFIG.canvasWidth;
    canvas.height = GAME_CONFIG.canvasHeight;

    const context = canvas.getContext("2d");
    context.strokeStyle = GAME_CONFIG.colors.grid;
    context.lineWidth = GAME_CONFIG.gridLineWidth;

    const beepSound = new Audio(GAME_CONFIG.beepSoundPath);

    const game = new SnakeGame({
        canvas,
        context,
        beepSound,
        scoreElement: document.getElementById("snakeSize"),
        overlayElement: document.getElementById("gameOver"),
        overlayTitleElement: document.getElementById("gameOverTitle"),
        finalScoreElement: document.getElementById("finalScore"),
    });

    game.start();
    return game;
}

if (typeof window !== "undefined" && !window.__SNAKE_DISABLE_AUTO_START__) {
    window.addEventListener("load", startGame);
}
