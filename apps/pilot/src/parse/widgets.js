// UI components in a view or a script: data tables, calendars, date pickers, charts, selects,
// modals, tabs, rich editors, uploads, trees and the rest, by the libraries' own calls (DataTables,
// Kendo, DevExtreme, ag-Grid, FullCalendar, flatpickr, select2, Chart.js…) and markup. Each is
// { kind, lib, line, target? }, `target` the selector or id it's bound to when the code says.
import { lineIndex } from '../text.js';

// jQuery plugins: $('#orders').DataTable({…}) → a data table on #orders.
const PLUGINS = {
  DataTable: ['data table', 'DataTables'],
  dataTable: ['data table', 'DataTables'],
  bootstrapTable: ['data table', 'bootstrap-table'],
  jqGrid: ['data table', 'jqGrid'],
  kendoGrid: ['data table', 'Kendo UI'],
  dxDataGrid: ['data table', 'DevExtreme'],
  igGrid: ['data table', 'Ignite UI'],
  footable: ['data table', 'FooTable'],
  tablesorter: ['data table', 'tablesorter'],
  fullCalendar: ['calendar', 'FullCalendar'],
  kendoScheduler: ['calendar', 'Kendo UI'],
  dxScheduler: ['calendar', 'DevExtreme'],
  datepicker: ['date picker', 'jQuery UI / bootstrap-datepicker'],
  datetimepicker: ['date picker', 'datetimepicker'],
  daterangepicker: ['date picker', 'daterangepicker'],
  kendoDatePicker: ['date picker', 'Kendo UI'],
  kendoDateTimePicker: ['date picker', 'Kendo UI'],
  dxDateBox: ['date picker', 'DevExtreme'],
  timepicker: ['date picker', 'timepicker'],
  select2: ['select', 'select2'],
  selectize: ['select', 'selectize'],
  chosen: ['select', 'Chosen'],
  selectpicker: ['select', 'bootstrap-select'],
  multiselect: ['select', 'multiselect'],
  kendoDropDownList: ['select', 'Kendo UI'],
  kendoComboBox: ['select', 'Kendo UI'],
  kendoMultiSelect: ['select', 'Kendo UI'],
  dxSelectBox: ['select', 'DevExtreme'],
  autocomplete: ['autocomplete', 'jQuery UI'],
  typeahead: ['autocomplete', 'typeahead'],
  kendoAutoComplete: ['autocomplete', 'Kendo UI'],
  modal: ['modal', 'Bootstrap'],
  dialog: ['modal', 'jQuery UI'],
  kendoWindow: ['modal', 'Kendo UI'],
  tabs: ['tabs', 'jQuery UI'],
  tab: ['tabs', 'Bootstrap'],
  kendoTabStrip: ['tabs', 'Kendo UI'],
  accordion: ['accordion', 'jQuery UI'],
  collapse: ['accordion', 'Bootstrap'],
  jstree: ['tree', 'jsTree'],
  fancytree: ['tree', 'Fancytree'],
  kendoTreeView: ['tree', 'Kendo UI'],
  dxTreeList: ['tree', 'DevExtreme'],
  treetable: ['tree', 'treetable'],
  summernote: ['rich editor', 'Summernote'],
  froalaEditor: ['rich editor', 'Froala'],
  kendoEditor: ['rich editor', 'Kendo UI'],
  fileupload: ['upload', 'jQuery File Upload'],
  dropzone: ['upload', 'Dropzone'],
  kendoUpload: ['upload', 'Kendo UI'],
  dxFileUploader: ['upload', 'DevExtreme'],
  kendoChart: ['chart', 'Kendo UI'],
  dxChart: ['chart', 'DevExtreme'],
  dxPieChart: ['chart', 'DevExtreme'],
  highcharts: ['chart', 'Highcharts'],
  sparkline: ['chart', 'Sparkline'],
  sortable: ['sortable', 'jQuery UI'],
  draggable: ['sortable', 'jQuery UI'],
  validate: ['validation', 'jQuery Validation'],
  mask: ['input mask', 'jQuery Mask'],
  inputmask: ['input mask', 'Inputmask'],
  tooltip: ['tooltip', 'Bootstrap / jQuery UI'],
  popover: ['tooltip', 'Bootstrap'],
  carousel: ['carousel', 'Bootstrap'],
  slick: ['carousel', 'Slick'],
  owlCarousel: ['carousel', 'Owl Carousel'],
  steps: ['wizard', 'jQuery Steps'],
  smartWizard: ['wizard', 'SmartWizard'],
  bootstrapWizard: ['wizard', 'bootstrap-wizard'],
  colorpicker: ['color picker', 'colorpicker'],
  spectrum: ['color picker', 'Spectrum'],
  slider: ['slider', 'jQuery UI'],
  ionRangeSlider: ['slider', 'Ion.RangeSlider'],
  kendoSlider: ['slider', 'Kendo UI'],
  kendoPanelBar: ['accordion', 'Kendo UI'],
  kendoMenu: ['menu', 'Kendo UI'],
  menu: ['menu', 'jQuery UI'],
  lightbox: ['lightbox', 'Lightbox'],
  fancybox: ['lightbox', 'Fancybox'],
  magnificPopup: ['lightbox', 'Magnific Popup'],
  infiniteScroll: ['infinite scroll', 'Infinite Scroll'],
  pagination: ['pagination', 'pagination'],
  twbsPagination: ['pagination', 'twbs-pagination'],
};

// Calls that aren't jQuery plugins: [pattern, kind, lib]; a first capture group is the target.
const CALLS = [
  [/new\s+(?:FullCalendar\.)?Calendar\s*\(\s*(?:document\.(?:getElementById|querySelector)\(\s*['"]([^'"]+)['"]\s*\))?/g, 'calendar', 'FullCalendar'],
  [/\bflatpickr\s*\(\s*['"]([^'"]+)['"]/g, 'date picker', 'flatpickr'],
  [/\bnew\s+Pikaday\s*\(/g, 'date picker', 'Pikaday'],
  [/\b(?:new\s+agGrid\.Grid|agGrid\.createGrid|createGrid)\s*\(\s*(?:document\.(?:getElementById|querySelector)\(\s*['"]([^'"]+)['"]\s*\))?/g, 'data table', 'ag-Grid'],
  [/\bnew\s+Tabulator\s*\(\s*['"]([^'"]+)['"]/g, 'data table', 'Tabulator'],
  [/\bnew\s+(?:DataTable|simpleDatatables\.DataTable)\s*\(\s*['"]([^'"]+)['"]/g, 'data table', 'DataTables'],
  [/\bnew\s+gridjs\.Grid\s*\(/g, 'data table', 'Grid.js'],
  [/\bnew\s+Handsontable\s*\(/g, 'data table', 'Handsontable'],
  [/\bnew\s+Chart\s*\(\s*(?:document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)|['"]([^'"]+)['"])?/g, 'chart', 'Chart.js'],
  [/\bHighcharts\.(?:chart|stockChart|mapChart)\s*\(\s*['"]([^'"]+)['"]/g, 'chart', 'Highcharts'],
  [/\becharts\.init\s*\(\s*(?:document\.getElementById\(\s*['"]([^'"]+)['"]\s*\))?/g, 'chart', 'ECharts'],
  [/\bnew\s+ApexCharts\s*\(\s*(?:document\.querySelector\(\s*['"]([^'"]+)['"]\s*\))?/g, 'chart', 'ApexCharts'],
  [/\bc3\.generate\s*\(/g, 'chart', 'C3'],
  [/\bd3\.select\s*\(\s*['"]([^'"]+)['"]/g, 'chart', 'D3'],
  [/\bgoogle\.visualization\.\w+Chart\s*\(/g, 'chart', 'Google Charts'],
  [/\bnew\s+TomSelect\s*\(\s*['"]([^'"]+)['"]/g, 'select', 'Tom Select'],
  [/\bnew\s+Choices\s*\(\s*['"]([^'"]+)['"]/g, 'select', 'Choices.js'],
  [/\bnew\s+bootstrap\.Modal\s*\(\s*(?:document\.getElementById\(\s*['"]([^'"]+)['"]\s*\))?/g, 'modal', 'Bootstrap'],
  [/\b(?:Swal\.fire|swal)\s*\(/g, 'modal', 'SweetAlert'],
  [/\bbootbox\.(?:dialog|confirm|alert|prompt)\s*\(/g, 'modal', 'Bootbox'],
  [/\btinymce\.init\s*\(\s*\{[^}]*?selector\s*:\s*['"]([^'"]+)['"]/g, 'rich editor', 'TinyMCE'],
  [/\bCKEDITOR\.replace\s*\(\s*['"]([^'"]+)['"]/g, 'rich editor', 'CKEditor'],
  [/\bClassicEditor\.create\s*\(/g, 'rich editor', 'CKEditor 5'],
  [/\bnew\s+Quill\s*\(\s*['"]([^'"]+)['"]/g, 'rich editor', 'Quill'],
  [/\bnew\s+Dropzone\s*\(\s*['"]([^'"]+)['"]/g, 'upload', 'Dropzone'],
  [/\bFilePond\.create\s*\(/g, 'upload', 'FilePond'],
  [/\bnew\s+Sortable\s*\(|Sortable\.create\s*\(/g, 'sortable', 'SortableJS'],
  [/\bdragula\s*\(/g, 'sortable', 'Dragula'],
  [/\bL\.map\s*\(\s*['"]([^'"]+)['"]/g, 'map', 'Leaflet'],
  [/\bnew\s+google\.maps\.Map\s*\(\s*(?:document\.getElementById\(\s*['"]([^'"]+)['"]\s*\))?/g, 'map', 'Google Maps'],
  [/\bnew\s+mapboxgl\.Map\s*\(/g, 'map', 'Mapbox'],
  [/\btoastr\.\w+\s*\(/g, 'notifications', 'toastr'],
  [/\bnew\s+Noty\s*\(/g, 'notifications', 'Noty'],
  [/\bko\.applyBindings\s*\(/g, 'framework', 'Knockout'],
  [/\bnew\s+Vue\s*\(|\bcreateApp\s*\(/g, 'framework', 'Vue'],
  [/\bReactDOM\.(?:render|createRoot)\s*\(|\bcreateRoot\s*\(/g, 'framework', 'React'],
  [/\bangular\.module\s*\(/g, 'framework', 'AngularJS'],
  [/\bAlpine\.start\s*\(/g, 'framework', 'Alpine.js'],
  [/\$\.connection\.\w+Hub|\bnew\s+signalR\.HubConnectionBuilder\s*\(/g, 'realtime', 'SignalR'],
  [/\bnew\s+Swiper\s*\(\s*['"]([^'"]+)['"]/g, 'carousel', 'Swiper'],
  [/\bIMask\s*\(/g, 'input mask', 'IMask'],
  [/\bnew\s+Cleave\s*\(\s*['"]([^'"]+)['"]/g, 'input mask', 'Cleave.js'],
  [/\bnew\s+(?:bootstrap\.)?(?:Tooltip|Popover)\s*\(/g, 'tooltip', 'Bootstrap'],
  [/\btippy\s*\(\s*['"]([^'"]+)['"]/g, 'tooltip', 'Tippy'],
  [/\bnew\s+Stepper\s*\(/g, 'wizard', 'bs-stepper'],
];

// Markup: server-side widgets and plain HTML worth counting. [pattern, kind, lib]; a capture is the target id.
const MARKUP = [
  [/@\(?\s*Html\.Kendo\(\)\.Grid\b[\s\S]{0,200}?\.Name\(\s*"([^"]+)"/g, 'data table', 'Kendo UI (MVC)'],
  [/@\(?\s*Html\.Kendo\(\)\.Scheduler\b[\s\S]{0,200}?\.Name\(\s*"([^"]+)"/g, 'calendar', 'Kendo UI (MVC)'],
  [/@\(?\s*Html\.Kendo\(\)\.(?:Date(?:Time)?Picker|DateRangePicker)\b[\s\S]{0,200}?\.Name\(\s*"([^"]+)"/g, 'date picker', 'Kendo UI (MVC)'],
  [/@\(?\s*Html\.Kendo\(\)\.(?:DropDownList|ComboBox|MultiSelect)\b[\s\S]{0,200}?\.Name\(\s*"([^"]+)"/g, 'select', 'Kendo UI (MVC)'],
  [/@\(?\s*Html\.Kendo\(\)\.Chart\b[\s\S]{0,200}?\.Name\(\s*"([^"]+)"/g, 'chart', 'Kendo UI (MVC)'],
  [/@\(?\s*Html\.Kendo\(\)\.(?:Window|Dialog)\b[\s\S]{0,200}?\.Name\(\s*"([^"]+)"/g, 'modal', 'Kendo UI (MVC)'],
  [/@\(?\s*Html\.Kendo\(\)\.(?:TabStrip)\b[\s\S]{0,200}?\.Name\(\s*"([^"]+)"/g, 'tabs', 'Kendo UI (MVC)'],
  [/@\(?\s*Html\.Kendo\(\)\.(?:TreeView|TreeList)\b[\s\S]{0,200}?\.Name\(\s*"([^"]+)"/g, 'tree', 'Kendo UI (MVC)'],
  [/@\(?\s*Html\.Kendo\(\)\.(?:Editor)\b[\s\S]{0,200}?\.Name\(\s*"([^"]+)"/g, 'rich editor', 'Kendo UI (MVC)'],
  [/@\(?\s*Html\.Kendo\(\)\.(?:Upload)\b[\s\S]{0,200}?\.Name\(\s*"([^"]+)"/g, 'upload', 'Kendo UI (MVC)'],
  [/@\(?\s*Html\.DevExtreme\(\)\.DataGrid\b[\s\S]{0,200}?\.ID\(\s*"([^"]+)"/g, 'data table', 'DevExtreme (MVC)'],
  [/@\(?\s*Html\.DevExtreme\(\)\.Scheduler\b/g, 'calendar', 'DevExtreme (MVC)'],
  [/@Html\.DevExpress\(\)\.GridView\b/g, 'data table', 'DevExpress (MVC)'],
  [/@\(?\s*Html\.Grid\(/g, 'data table', 'MvcGrid / Grid.Mvc'],
  [/<(?:ejs-grid|e-grid)\b[^>]*\bid="([^"]+)"/g, 'data table', 'Syncfusion'],
  [/<table\b(?=[^>]*\bclass="[^"]*\b(?:datatable|data-table|dataTable|js-datatable)\b)(?=(?:[^>]*\bid="([^"@]+)")?)/g, 'data table', 'DataTables (markup)'],
  [/<input\b[^>]*\btype="(?:date|datetime-local|time|month|week)"/g, 'date picker', 'HTML input'],
  [/<input\b[^>]*\btype="file"/g, 'upload', 'HTML input'],
  [/<div\b(?=[^>]*\bclass="(?:[^"]*\s)?modal(?:\s[^"]*)?")(?=(?:[^>]*\bid="([^"@]+)")?)/g, 'modal', 'Bootstrap'],
  [/\bdata-(?:bs-)?toggle="tab"|\bclass="[^"]*\bnav-tabs\b/g, 'tabs', 'Bootstrap'],
  [/\bclass="[^"]*\baccordion\b/g, 'accordion', 'Bootstrap'],
  [/\bclass="[^"]*\bcarousel\b[^"]*"/g, 'carousel', 'Bootstrap'],
  [/<canvas\b[^>]*\bid="([^"@]+)"/g, 'chart', 'canvas'],
  [/\bdata-bind\s*=/g, 'framework', 'Knockout'],
  [/\bng-app\b|\bng-controller\b/g, 'framework', 'AngularJS'],
  [/\bx-data\b/g, 'framework', 'Alpine.js'],
  [/<form\b|@using\s*\(\s*(?:Html|Ajax)\.Begin(?:Route)?Form\b/g, 'form', 'HTML'],
  [/<table\b/g, 'table', 'HTML'],
  [/\bdata-val\s*=\s*"true"|@Html\.ValidationMessageFor\b|asp-validation-for\b/g, 'validation', 'unobtrusive validation'],
  [/<(?:ul|div)\b[^>]*\bclass="[^"]*\bpagination\b/g, 'pagination', 'Bootstrap'],
];

/**
 * The widgets in `text` (comments already blanked): `scripts` reads library calls, `markup` the HTML
 * and server-side helpers (a view's own; its inline scripts are read as scripts).
 */
export function findWidgets(text, { markup = false, scripts = true } = {}) {
  const lineOf = lineIndex(text);
  const out = [];
  const seen = new Set();
  const push = (kind, lib, offset, target) => {
    const line = lineOf(offset);
    // Forms, tables and validation are counted once a line; widgets once per line and target.
    const key = `${kind}|${line}|${target ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, lib, line, ...(target ? { target } : {}) });
  };
  const names = Object.keys(PLUGINS).join('|');
  // $('#orders').DataTable(…), $("#start").datepicker(…), $(this).find('.x').select2(…)
  const jq = new RegExp(String.raw`(?:\$|jQuery)\(\s*(?:(['"\`])((?:(?!\1).){1,120})\1|[\w.]+)\s*\)((?:\s*\.\s*(?:find|children|closest|filter|not|first|last|eq|addClass)\s*\([^()]*\))*)\s*\.\s*(${names})\s*\(`, 'g');
  for (const m of scripts ? text.matchAll(jq) : []) {
    const [kind, lib] = PLUGINS[m[4]];
    // .modal('hide') and .tab('show') are uses of a widget, not new ones; .tooltip() on many is one.
    if ((m[4] === 'modal' || m[4] === 'tab' || m[4] === 'collapse') && /^\s*\(\s*['"](hide|toggle|dispose|handleUpdate)['"]/.test(text.slice(m.index + m[0].length - 1, m.index + m[0].length + 20))) continue;
    const inner = /\.find\s*\(\s*['"]([^'"]+)['"]/.exec(m[3] ?? '')?.[1];
    push(kind, lib, m.index, inner ?? m[2] ?? null);
  }
  if (scripts) for (const [re, kind, lib] of CALLS) for (const m of text.matchAll(re)) push(kind, lib, m.index, m[1] ?? m[2] ?? null);
  if (markup) {
    for (const [re, kind, lib] of MARKUP) {
      for (const m of text.matchAll(re)) {
        const id = m[1] ?? m[2] ?? null;
        push(kind, lib, m.index, id ? (/^[#.[]/.test(id) ? id : `#${id}`) : null);
      }
    }
  }
  return out;
}
