using System.Web.Mvc;

namespace Shop.Web.Controllers
{
    [Authorize]
    public class OrdersController : Controller
    {
        public ActionResult Index()
        {
            var model = new OrdersViewModel();
            return View(model);
        }

        [HttpGet]
        public ActionResult Edit(int id)
        {
            if (id == 0) { return RedirectToAction("Index"); }
            return View(new OrderViewModel { Id = id });
        }

        [HttpPost]
        [ValidateAntiForgeryToken]
        public JsonResult Save(OrderViewModel order)
        {
            return Json(new { ok = true, message = "Saved {0}" });
        }

        public PartialViewResult Row(int id)
        {
            return PartialView("_OrderRow", new OrderRow { Id = id });
        }

        [ChildActionOnly]
        public PartialViewResult CartSummary()
        {
            return PartialView();
        }

        [NonAction]
        public ActionResult Helper() { return View("Nope"); }
    }
}
