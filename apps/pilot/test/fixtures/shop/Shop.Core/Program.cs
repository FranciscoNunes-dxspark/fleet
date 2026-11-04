var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapControllerRoute(name: "default", pattern: "{controller=Products}/{action=Index}/{id?}");
app.Run();
