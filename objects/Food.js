/** Comida que a cobra precisa alcançar para crescer. */
class Food {

    /**
     * @param {World} world Tabuleiro onde a comida é desenhada.
     * @param {function(): number} [randomSource] Fonte de números aleatórios em
     *   `[0, 1)`. Pode ser substituída em testes por uma função determinística.
     */
    constructor(world, randomSource) {
        this.world = world;
        /** Posição X (px) da comida, sempre alinhada à grade. */
        this.positionX = 0;
        /** Posição Y (px) da comida, sempre alinhada à grade. */
        this.positionY = 0;
        /** Indica se existe uma posição válida sorteada para a comida. */
        this.hasPosition = false;
        /** Fonte de aleatoriedade (injetável para testes). */
        this.randomSource = randomSource || Math.random;
    }

    /**
     * Verifica se a cabeça da cobra está em cima da comida.
     * Apenas informa o resultado: quem sorteia a próxima posição é o `game.js`,
     * que decide quando chamar `generateRandomFoodPosition`.
     */
    isColliding(positionX, positionY) {
        if (!this.hasPosition) {
            return false;
        }
        return positionX === this.positionX && positionY === this.positionY;
    }

    /** Desenha a comida na posição atual (se houver uma posição válida). */
    generateFood() {
        if (!this.hasPosition) {
            return;
        }
        this.world.fillBox(this.positionX, this.positionY, GAME_CONFIG.colors.food);
    }

    /**
     * Sorteia uma nova posição para a comida, alinhada à grade, dentro do
     * canvas e fora de todas as células ocupadas pela cobra.
     *
     * Estratégia: monta a lista de células livres e escolhe uma delas. Assim,
     * não há laço de tentativas-e-erros — quando o tabuleiro está cheio, o
     * resultado é imediatamente "sem posição".
     *
     * @param {{x: number, y: number}[]} [occupiedCells] Células bloqueadas
     *   (corpo + cabeça da cobra). Se omitido, nenhuma célula é bloqueada.
     * @returns {{x: number, y: number} | null} A posição sorteada ou `null`
     *   quando não há nenhuma célula livre no tabuleiro.
     */
    generateRandomFoodPosition(occupiedCells = []) {
        const freeCells = this.getFreeCells(occupiedCells);
        if (freeCells.length === 0) {
            this.hasPosition = false;
            return null;
        }

        const index = Math.floor(this.randomSource() * freeCells.length);
        const chosenCell = freeCells[Math.min(index, freeCells.length - 1)];

        this.positionX = chosenCell.x;
        this.positionY = chosenCell.y;
        this.hasPosition = true;
        return { x: this.positionX, y: this.positionY };
    }

    /**
     * Lista todas as células do tabuleiro que não estão ocupadas, em px e na
     * ordem linha a linha. Células ocupadas são comparadas por igualdade exata
     * de coordenadas.
     *
     * @param {{x: number, y: number}[]} occupiedCells
     * @returns {{x: number, y: number}[]}
     */
    getFreeCells(occupiedCells) {
        const boxSize = this.world.boxSizeInPx;
        const columns = Math.floor(this.world.canvasWidth / boxSize);
        const rows = Math.floor(this.world.canvasHeight / boxSize);

        const occupiedKeys = new Set(
            occupiedCells.map((cell) => `${cell.x},${cell.y}`),
        );

        const freeCells = [];
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                const cell = { x: column * boxSize, y: row * boxSize };
                if (!occupiedKeys.has(`${cell.x},${cell.y}`)) {
                    freeCells.push(cell);
                }
            }
        }
        return freeCells;
    }
}
