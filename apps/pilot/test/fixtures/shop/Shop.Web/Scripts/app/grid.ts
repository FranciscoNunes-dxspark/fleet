export class Grid {
    constructor(private table: HTMLElement) {}

    select(row: HTMLElement): void {
        row.classList.add('selected');
    }
}
