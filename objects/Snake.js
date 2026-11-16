/**
 * A cobra: controla a própria posição, direção, crescimento e desenho.
 *
 * Todas as coordenadas guardadas na cobra (cabeça e corpo) ficam sempre
 * normalizadas dentro do tabuleiro. Assim, ao atravessar uma borda, a cabeça
 * já aparece na célula oposta e o corpo continua sendo desenhado a partir de
 * posições válidas — sem segmentos "perdidos" fora do canvas.
 */
class Snake {
    constructor(world) {
        this.world = world;
        /** Posição X (px) da cabeça, sempre alinhada à grade e dentro do canvas. */
        this.positionX = 0;
        /** Posição Y (px) da cabeça, sempre alinhada à grade e dentro do canvas. */
        this.positionY = 0;
        /** Tamanho atual da cobra, em quadradinhos (inclui a cabeça). */
        this.size = 1;

        /**
         * Células ocupadas pela cobra, da ponta da cauda até a cabeça
         * (a última posição é sempre a cabeça). Cada item: `{ x, y }` em px.
         */
        this.tail = [{ x: this.positionX, y: this.positionY }];
        /** Direção pedida pelo jogador (alterada pelo teclado em game.js). */
        this.direction = DIRECTION.RIGHT;
        /** Última direção realmente seguida, usada para bloquear meia-volta. */
        this.lastDirection = DIRECTION.RIGHT;
        /** Indica que a cobra bateu no próprio corpo e a partida terminou. */
        this.isGameOver = false;
    }

    /**
     * Executa um passo completo da cobra: move, atualiza o corpo,
     * checa colisão com o próprio corpo e desenha.
     */
    drawSnake() {
        if (this.isGameOver) {
            return;
        }

        this.filterDirection();
        this.moveSnake();
        this.getSnakeTrail();
        this.drawTail();
        this.drawBox(this.positionX, this.positionY);
        this.dontColideWithOwnTail();
    }

    /** Aumenta o tamanho da cobra em um quadradinho. */
    eatFood() {
        this.size += 1;
    }

    /**
     * Normaliza a cabeça para dentro do tabuleiro, fazendo-a reaparecer do
     * lado oposto quando ultrapassa uma borda.
     */
    dontColideWithEndOfCanvas() {
        this.positionX = this.wrapCoordinate(this.positionX, this.world.canvasWidth);
        this.positionY = this.wrapCoordinate(this.positionY, this.world.canvasHeight);
    }

    /**
     * Impede a cobra de dar meia-volta: se o jogador pedir a direção oposta
     * à última seguida, ela continua na direção anterior.
     */
    filterDirection() {
        const isReversing = OPPOSITE_DIRECTION[this.direction] === this.lastDirection;
        if (isReversing) {
            this.direction = this.lastDirection;
        } else {
            this.lastDirection = this.direction;
        }
    }

    /**
     * Move a cabeça um quadradinho na direção atual e imediatamente a
     * reposiciona dentro do tabuleiro, caso tenha cruzado uma borda.
     */
    moveSnake() {
        const vector = DIRECTION_VECTOR[this.direction];
        this.positionX += vector.x * this.world.boxSizeInPx;
        this.positionY += vector.y * this.world.boxSizeInPx;
        this.dontColideWithEndOfCanvas();
    }

    /**
     * Registra a posição atual da cabeça no corpo e descarta o excesso
     * da ponta da cauda para manter o tamanho da cobra.
     *
     * Enquanto a cobra não come, o tamanho não muda e a ponta da cauda é
     * removida — ou seja, a célula que ela desocupa pode ser usada pela
     * cabeça no mesmo passo, como no Snake tradicional.
     */
    getSnakeTrail() {
        this.tail.push({ x: this.positionX, y: this.positionY });
        while (this.tail.length > this.size) {
            this.tail.shift();
        }
    }

    /** Desenha o corpo da cobra. */
    drawTail() {
        this.tail.forEach((segment) => this.drawBox(segment.x, segment.y));
    }

    /**
     * Termina o jogo se a cabeça encostar em alguma parte do próprio corpo.
     *
     * A verificação usa as coordenadas já normalizadas (pós-teletransporte),
     * portanto uma cabeça que cruzou a borda colide com um segmento que
     * esteja na célula oposta. A própria cabeça é ignorada.
     *
     * @returns {boolean} `true` se houve colisão com o corpo.
     */
    dontColideWithOwnTail() {
        const head = { x: this.positionX, y: this.positionY };
        const lastIndex = this.tail.length - 1;
        const hitItself = this.tail.some((segment, index) => {
            const isHeadEntry = index === lastIndex && this.isSameCell(segment, head);
            return !isHeadEntry && this.isSameCell(segment, head);
        });

        if (hitItself) {
            this.isGameOver = true;
        }
        return hitItself;
    }

    /**
     * Finaliza a partida sem recarregar a página. Quem decide o que mostrar
     * e quando parar o loop é o `game.js`.
     */
    gameOver() {
        this.isGameOver = true;
    }

    /**
     * Devolve todas as células ocupadas pela cobra (corpo + cabeça), sem
     * repetições. Usado pela comida para nunca sortear uma posição inválida.
     *
     * @returns {{x: number, y: number}[]}
     */
    getOccupiedCells() {
        const cells = [];
        const seen = new Set();
        const head = { x: this.positionX, y: this.positionY };

        const addCell = (cell) => {
            const key = `${cell.x},${cell.y}`;
            if (!seen.has(key)) {
                seen.add(key);
                cells.push({ x: cell.x, y: cell.y });
            }
        };

        this.tail.forEach(addCell);
        addCell(head);
        return cells;
    }

    /**
     * Aplica a regra de "dar a volta" a uma coordenada de um eixo.
     *
     * A coordenada é convertida para índice de célula e normalizada com
     * aritmética modular, garantindo que o resultado fique entre `0` e
     * `limit - boxSize` e continue alinhado à grade.
     */
    wrapCoordinate(coordinate, limit) {
        const boxSize = this.world.boxSizeInPx;
        const cellsCount = Math.floor(limit / boxSize);
        if (cellsCount <= 0) {
            return 0;
        }

        const cellIndex = Math.floor(coordinate / boxSize);
        const wrappedIndex = ((cellIndex % cellsCount) + cellsCount) % cellsCount;
        return wrappedIndex * boxSize;
    }

    /** Compara duas células da grade. */
    isSameCell(first, second) {
        return first.x === second.x && first.y === second.y;
    }

    /**
     * Pinta um quadradinho com a cor da cobra.
     */
    drawBox(positionX, positionY) {
        this.world.fillBox(positionX, positionY, GAME_CONFIG.colors.snake);
    }
}
