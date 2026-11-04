namespace Shop.Core.Controllers;

[Route("products")]
public class ProductsController : Controller
{
    [HttpGet("")]
    public IActionResult Index() => View();

    [HttpGet("{id:int}")]
    public async Task<IActionResult> Details(int id)
    {
        var product = await _repo.Find(id);
        return View(product);
    }
}
