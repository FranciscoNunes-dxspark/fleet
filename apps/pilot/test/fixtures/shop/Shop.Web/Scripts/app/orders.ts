/// <reference path="../typings/jquery.d.ts" />
import { Grid } from './grid';

namespace Orders {
    export function save() {
        const rows = $('.order-table tr.order-row');
        $.post('/Orders/Save', { rows: rows.length });
        $('#orders').find('.late').addClass('is-dirty');
        document.getElementById('order-form');
        $(document).on('click', '.btn-save', () => save());
    }

    export function addRow(id: number) {
        $.get('/Orders/Row/' + id, (html: string) => {
            $('#orders').append(html);
        });
    }

    $('#orders').DataTable({ paging: true });
    $('.date-picker').datepicker();
}
