using System.Web.Mvc;

namespace Shop.Web.Controllers
{
    public class HomeController : Controller
    {
        public ActionResult Index()
        {
            return View();
        }

        // About shares the home page's view.
        public ActionResult About() => View("Index");
    }
}
