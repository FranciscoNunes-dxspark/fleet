export function initProducts(): void {
    document.querySelectorAll('.product-card .price').forEach((el) => el.classList.toggle('on-sale'));
    fetch(`/products/${1}`);
}
