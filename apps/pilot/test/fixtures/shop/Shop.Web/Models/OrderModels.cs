using System.Collections.Generic;

namespace Shop.Web.Models
{
    public class OrdersViewModel
    {
        public List<OrderRow> Orders { get; set; }
        public decimal Total { get; set; }
        public string PartialName { get; set; }
    }

    public class OrderRow
    {
        public int Id { get; set; }
        public string Number { get; set; }
        public bool Late { get; set; }
        public string Notes { get; set; }
    }

    public class OrderViewModel
    {
        public int Id { get; set; }
        public System.DateTime? Date { get; set; }
    }
}
