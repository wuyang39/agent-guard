from pathlib import Path
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOT = ROOT / "outputs" / "http-agent-review.png"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 960})
    console_errors: list[str] = []
    page.on(
        "console",
        lambda message: console_errors.append(message.text)
        if message.type == "error"
        else None,
    )

    page.goto("http://127.0.0.1:5173", wait_until="networkidle")
    page.get_by_role("button", name="智能体接入").click()
    page.locator("button.environment-mode-card").filter(
        has_text="标准 HTTP 服务接入"
    ).click()

    assert page.get_by_label("智能体 ID").input_value() == "agent.http.runtime"
    assert page.get_by_label("HTTP 接口地址").input_value() == (
        "http://127.0.0.1:7002/agent/run"
    )

    page.get_by_role("button", name="检测连接").click()
    page.get_by_text("连接可用", exact=True).wait_for(timeout=10_000)
    page.get_by_role("button", name="保存配置").click()

    page.get_by_role("button", name="检测编排").click()
    page.get_by_role("button", name="生成用例计划").click()
    run_button = page.get_by_role("button", name="运行检测生成策略包")
    run_button.wait_for(state="visible", timeout=20_000)
    page.wait_for_function(
        """() => {
          const button = [...document.querySelectorAll('button')]
            .find((item) => item.textContent?.includes('运行检测生成策略包'));
          return button && !button.disabled;
        }""",
        timeout=20_000,
    )
    run_button.click()
    page.get_by_text("防御报告已生成", exact=True).wait_for(timeout=90_000)
    page.screenshot(path=str(SCREENSHOT), full_page=True)

    assert not console_errors, "Browser console errors: " + " | ".join(console_errors)
    print(f"http-agent-web-ok screenshot={SCREENSHOT}")
    browser.close()
