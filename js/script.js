// --- BASE CANVAS SETUP ---
const width = 800;
const height = 400;
const margin = { top: 40, right: 120, bottom: 50, left: 60 };

// Shared HTML Tooltip
const tooltip = d3.select("body").append("div")
    .attr("class", "chart-tooltip")
    .attr("id", "chart-tooltip")
    .attr("role", "tooltip")
    .attr("aria-hidden", "true");

const TOOLTIP_ID = "chart-tooltip";

function showTooltip(html, x, y, el) {
    tooltip.attr("aria-hidden", "false").style("opacity", 1).html(html)
        .style("left", x + "px").style("top", y + "px");
    if (el) el.setAttribute("aria-describedby", TOOLTIP_ID);
}

function hideTooltip(el) {
    tooltip.attr("aria-hidden", "true").style("opacity", 0);
    if (el) el.removeAttribute("aria-describedby");
}

function showChartTip(el, html, e) {
    if (e.type === "focus") {
        const r = el.getBoundingClientRect();
        showTooltip(html, r.left + window.scrollX + r.width / 2, r.top + window.scrollY - 15, el);
    } else {
        showTooltip(html, e.pageX + 15, e.pageY - 15);
    }
}

function announceDashboardStatus(tCases, fnCases, mStay) {
    const el = document.getElementById("dashboard-status");
    if (!el) return;
    el.textContent = `${tCases.toLocaleString()} hospitalisations shown. First Nations: ${fnCases.toLocaleString()}. Mean stay: ${mStay.toFixed(1)} days.`;
}

function showAppMessage(text, type) {
    const el = document.getElementById("app-message");
    if (!el) return;
    el.textContent = text;
    el.className = "app-message app-message--" + (type || "error");
    el.hidden = false;
}

function hideAppMessage() {
    const el = document.getElementById("app-message");
    if (el) el.hidden = true;
}

const CHART_TRANSITION_MS = 650;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let dashboardChartsReady = false;

function chartTransition(selection) {
    return selection.transition().duration(CHART_TRANSITION_MS).ease(d3.easeCubicInOut);
}

function applyTransition(selection, animate) {
    return animate ? chartTransition(selection) : selection;
}

function tweenPathY(line, prevData, nextData, yKey) {
    return function () {
        return function (t) {
            const blended = prevData.map((d, i) => ({
                year: d.year,
                [yKey]: d[yKey] + t * (nextData[i][yKey] - d[yKey])
            }));
            return line(blended);
        };
    };
}

function tweenKpiText(selector, endValue, format) {
    const el = d3.select(selector);
    const node = el.node();
    if (!node) return;
    const parsed = parseFloat(String(node.textContent).replace(/[^\d.-]/g, ""));
    const startValue = Number.isFinite(parsed) ? parsed : 0;
    chartTransition(el).tween("text", () => {
        const i = d3.interpolateNumber(startValue, endValue);
        return t => { node.textContent = format(i(t)); };
    });
}

// --- DATA STATE & FILTERS ---
let rawFN = [];
let rawHosp = [];

let dashFilters = {
    gender: "All",
    year: "All",
    region: "All",
    age: "All",
    roadUser: "All"  // FIX #3: camelCase matches fState.roadUser used in filterHospData
};

let activeScrollyStep = 0;
let scrollyNavigating = false;

d3.selectAll(".canvas-mount, .dash-card-canvas").each(function () {
    d3.select(this).append("div").attr("class", "chart-loading").attr("role", "status").text("Loading hospitalisation data…");
});

// --- DATA LOADING ---
Promise.all([
    d3.csv("data/First-Nations-hospitalised-injuries-compiled-raw.csv"),
    d3.csv("data/hospitalisation_injury_publication_sep2023.csv")
]).then(([fnData, hospData]) => {

    // Clean numerics
    const cleanNum = v => +String(v).replace(/,/g, "").replace("n.p.", "0").trim() || 0;

    rawFN = fnData.filter(d => d["Cause of injury = traffic"] === "Traffic").map(d => ({
        year: +d["Calendar year"],
        status: d["First Nations status"].trim(),
        catType: d["Category Type"].trim(),
        catValue: d["Category Value"].trim(),
        cases: cleanNum(d["Hospitalisations"]),
        days: cleanNum(d["Bed days excluding died in hospitals within 30 days"])
    }));

    rawHosp = hospData.filter(d => d["Cause of injury"] === "Traffic").map(d => ({
        year: +d["Calendar year"],
        month: d["Month"].trim(),
        area: d["ABS remoteness area"].trim(),
        sex: d["Sex"].trim(),
        age: d["Age group"].trim(),
        roadUser: d["Road user"].trim(),
        cases: cleanNum(d["Hospitalisations"]),
        days: cleanNum(d["Bed days"])
    }));

    hideAppMessage();
    d3.selectAll(".chart-loading").remove();
    initScrolly();
    syncScrollyStep(0, false);
    renderDashboard();
}).catch(err => {
    console.error("Error loading data:", err);
    d3.selectAll(".chart-loading").remove();
    showAppMessage("Unable to load hospitalisation data. Please refresh the page or try again later.", "error");
});


// --- HELPER MAPPINGS ---
function mapVehicle(ru) {
    const s = String(ru).toLowerCase();
    if (s.includes("pedestrian")) return "Pedestrian";
    if (s.includes("pedal") || s.includes("bicycle")) return "Bicycle";
    if (s.includes("motorcycl")) return "Motorcycle";
    if (s.includes("heavy") || s.includes("bus")) return "Truck";
    if (s.includes("car") || s.includes("pick-up") || s.includes("van") || s.includes("occupant")) return "Car";
    return "Other";
}

// FIX #4: Updated matchAge to correctly handle HOSP data's 65-74 and 75+ age groups
function matchAge(dbAge, filterAge) {
    if (filterAge === "All") return true;
    const a = dbAge.toLowerCase();
    if (filterAge === "0-16" && (a.includes("0-4") || a.includes("5-14") || a.includes("0-7") || a.includes("8-16"))) return true;
    if (filterAge === "17-25" && (a.includes("15-24") || a.includes("17-25"))) return true;
    if (filterAge === "26-64" && (a.includes("25-44") || a.includes("45-64") || a.includes("26-39") || a.includes("40-64"))) return true;
    if (filterAge === "65+" && (a.includes("65+") || a.startsWith("65-") || a === "75+" || a.startsWith("75-"))) return true;
    return false;
}

// Data pipelines
function filterHospData(fState) {
    return rawHosp.filter(d => {
        if (fState.year !== "All" && d.year !== +fState.year) return false;
        // FIX #2: Use exact match to prevent "Male" from matching "Female"
        if (fState.gender !== "All" && d.sex.toLowerCase() !== fState.gender.toLowerCase()) return false;
        if (fState.region !== "All" && !d.area.toLowerCase().includes(fState.region.toLowerCase().substring(0, 4))) return false;
        if (fState.roadUser !== "All" && mapVehicle(d.roadUser) !== fState.roadUser) return false;
        if (!matchAge(d.age, fState.age)) return false;
        return true;
    });
}

// --- DASHBOARD RENDERING ROUTER ---
function renderDashboard() {
    const hospSubset = filterHospData(dashFilters);

    // KPI Math
    const tCases = d3.sum(hospSubset, d => d.cases);
    const tDays = d3.sum(hospSubset, d => d.days);
    const mStay = tCases > 0 ? (tDays / tCases) : 0;

    let fnBase = rawFN.filter(d => d.catType === "Age group");
    if (dashFilters.year !== "All") fnBase = fnBase.filter(d => d.year === +dashFilters.year);

    // FIX #1 (KPI): sum all age groups instead of filtering for non-existent "All ages"
    if (dashFilters.age !== "All") {
        fnBase = fnBase.filter(d => matchAge(d.catValue, dashFilters.age));
    }
    // When age === "All", use all individual age group rows (they sum correctly per year/status)

    const fnCases = d3.sum(fnBase.filter(d => d.status === "First Nations people"), d => d.cases);

    const animate = dashboardChartsReady && !prefersReducedMotion;
    if (animate) {
        tweenKpiText("#kpi-total-cases", tCases, v => Math.round(v).toLocaleString());
        tweenKpiText("#kpi-fn-cases", fnCases, v => Math.round(v).toLocaleString());
        tweenKpiText("#kpi-severity-index", mStay, v => v.toFixed(2) + " d");
    } else {
        d3.select("#kpi-total-cases").text(tCases.toLocaleString());
        d3.select("#kpi-fn-cases").text(fnCases.toLocaleString());
        d3.select("#kpi-severity-index").text(mStay.toFixed(2) + " d");
    }

    // Draw Charts
    drawLineChart("dash-canvas-line", dashFilters, animate);
    drawPyramidChart("dash-canvas-pyramid", dashFilters, animate);
    drawSpiralChart("dash-canvas-spiral", dashFilters, animate);
    drawSankeyChart("dash-canvas-bar", dashFilters, animate);

    dashboardChartsReady = true;
    announceDashboardStatus(tCases, fnCases, mStay);
}

d3.selectAll(".filter-sidebar select").on("change", function () {
    let id = d3.select(this).attr("id").replace("global-", "");
    if (id === "roaduser") id = "roadUser";
    dashFilters[id] = this.value;
    hideAppMessage();
    renderDashboard();
});

// --- CSV EXPORT ---
document.getElementById("export-csv-btn").addEventListener("click", () => {
    const subset = filterHospData(dashFilters);

    if (subset.length === 0) {
        showAppMessage("No data matches the current filters — nothing to export.", "error");
        return;
    }

    hideAppMessage();

    // Build CSV header + rows
    const headers = ["Year", "Month", "Region", "Sex", "Age Group", "Road User", "Hospitalisations", "Bed Days"];
    const rows = subset.map(d => [
        d.year,
        d.month,
        d.area,
        d.sex,
        d.age,
        d.roadUser,
        d.cases,
        d.days
    ]);

    const csvContent = [headers, ...rows]
        .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
        .join("\n");

    // Compose a descriptive filename from active filters
    const parts = [];
    if (dashFilters.year !== "All") parts.push(dashFilters.year);
    if (dashFilters.region !== "All") parts.push(dashFilters.region.replace(/\s+/g, "-"));
    if (dashFilters.gender !== "All") parts.push(dashFilters.gender);
    if (dashFilters.age !== "All") parts.push(`age-${dashFilters.age}`);
    if (dashFilters.roadUser !== "All") parts.push(dashFilters.roadUser);
    const filename = `road-safety-export${parts.length ? "-" + parts.join("-") : ""}.csv`;

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showAppMessage(`Exported ${subset.length.toLocaleString()} rows to ${filename}.`, "success");
});

// --- RESET FILTERS ---
document.getElementById("reset-filters-btn").addEventListener("click", () => {
    dashFilters = {
        gender: "All",
        year: "All",
        region: "All",
        age: "All",
        roadUser: "All"
    };

    d3.select("#global-gender").property("value", "All");
    d3.select("#global-year").property("value", "All");
    d3.select("#global-region").property("value", "All");
    d3.select("#global-age").property("value", "All");
    d3.select("#global-roaduser").property("value", "All");

    hideAppMessage();
    renderDashboard();
});

// --- CHART BUILDERS ---

// 1. Line Chart (Indexed % Growth with Safe Math & Universal Hover)
function drawLineChart(containerId, fState, animate) {
    const isDashboard = containerId.startsWith("dash-canvas-");
    const parent = d3.select("#" + containerId);
    let svg = parent.select("svg");
    const updating = isDashboard && !svg.empty();

    if (!isDashboard || !updating) parent.html("");

    // FIX #1: "All ages" row doesn't exist in the data — sum all individual age groups per year.
    let subset;
    if (fState.age === "All") {
        subset = rawFN.filter(d => d.catType === "Age group");
    } else {
        subset = rawFN.filter(d => d.catType === "Age group" && matchAge(d.catValue, fState.age));
    }

    const years = [2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021];

    let data = years.map(yr => {
        const fn = d3.sum(subset.filter(d => d.year === yr && d.status === "First Nations people"), d => d.cases);
        const non = d3.sum(subset.filter(d => d.year === yr && d.status === "Non-Indigenous"), d => d.cases);
        return { year: yr, fn: fn, non: non, nat: fn + non };
    });

    const baseFn = data[0].fn || 1;
    const baseNon = data[0].non || 1;
    const baseNat = data[0].nat || 1;

    data = data.map(d => ({
        year: d.year,
        fnIdx: baseFn === 0 ? 0 : (d.fn / baseFn) * 100,
        nonIdx: baseNon === 0 ? 0 : (d.non / baseNon) * 100,
        natIdx: baseNat === 0 ? 0 : (d.nat / baseNat) * 100,
        fnRaw: d.fn, nonRaw: d.non, natRaw: d.nat
    }));

    const x = d3.scalePoint().domain(data.map(d => d.year)).range([margin.left, width - margin.right]);

    let maxVal = d3.max(data, d => Math.max(d.fnIdx, d.nonIdx, d.natIdx));
    if (!maxVal || isNaN(maxVal)) maxVal = 100;

    const y = d3.scaleLinear().domain([0, maxVal * 1.15]).range([height - margin.bottom, margin.top]);

    if (!updating) {
        svg = parent.append("svg").attr("viewBox", `0 0 ${width} ${height}`);
        svg.append("title").text("Indexed growth trajectory: First Nations, Non-Indigenous, and National transport injuries over time");
        svg.append("g").attr("transform", `translate(0, ${height - margin.bottom})`).attr("class", "axis axis-x");
        svg.append("g").attr("transform", `translate(${margin.left},0)`).attr("class", "axis axis-y");
        svg.append("g").attr("class", "grid").attr("transform", `translate(${margin.left}, 0)`);
        svg.selectAll(".axis, .grid").attr("aria-hidden", "true");

        svg.append("path").attr("class", "line-nat").attr("fill", "none").attr("stroke", "var(--chart-orange)").attr("stroke-dasharray", "4,4").attr("stroke-width", 2).attr("aria-hidden", "true");
        svg.append("path").attr("class", "line-non").attr("fill", "none").attr("stroke", "var(--chart-blue)").attr("stroke-dasharray", "4,4").attr("stroke-width", 2).attr("aria-hidden", "true");
        svg.append("path").attr("class", "line-fn").attr("fill", "none").attr("stroke", "var(--accent-red)").attr("stroke-width", 3).attr("aria-hidden", "true");

        svg.append("text").attr("class", "chart-label line-label line-label-fn").attr("x", width - margin.right + 10).style("fill", "var(--accent-red)").style("font-weight", "bold").text("First Nations").attr("aria-hidden", "true");
        svg.append("text").attr("class", "chart-label line-label line-label-non").attr("x", width - margin.right + 10).style("fill", "var(--chart-blue)").style("font-weight", "bold").text("Non-Indigenous").attr("aria-hidden", "true");
        svg.append("text").attr("class", "chart-label line-label line-label-nat").attr("x", width - margin.right + 10).style("fill", "var(--chart-orange)").style("font-weight", "bold").text("National").attr("aria-hidden", "true");
    }

    const lNat = d3.line().x(d => x(d.year)).y(d => y(d.natIdx)).curve(d3.curveMonotoneX);
    const lNon = d3.line().x(d => x(d.year)).y(d => y(d.nonIdx)).curve(d3.curveMonotoneX);
    const lFn = d3.line().x(d => x(d.year)).y(d => y(d.fnIdx)).curve(d3.curveMonotoneX);

    applyTransition(svg.select(".axis-x"), animate && updating).call(d3.axisBottom(x));
    applyTransition(svg.select(".axis-y"), animate && updating).call(d3.axisLeft(y).ticks(6).tickFormat(d => d + "%"));
    applyTransition(svg.select(".grid"), animate && updating).call(d3.axisLeft(y).ticks(6).tickSize(-width + margin.left + margin.right).tickFormat(""));

    const lineSeries = [
        { cls: "line-nat", line: lNat, key: "natIdx" },
        { cls: "line-non", line: lNon, key: "nonIdx" },
        { cls: "line-fn", line: lFn, key: "fnIdx" }
    ];

    lineSeries.forEach(s => {
        const path = svg.select("." + s.cls);
        const prevData = path.datum() || data;
        path.datum(data);
        if (animate && updating) {
            path.transition().duration(CHART_TRANSITION_MS).ease(d3.easeCubicInOut)
                .attrTween("d", tweenPathY(s.line, prevData, data, s.key));
        } else {
            path.attr("d", s.line);
        }
    });

    const labelPos = [
        { cls: "line-label-fn", y: y(data[10].fnIdx) },
        { cls: "line-label-non", y: y(data[10].nonIdx) },
        { cls: "line-label-nat", y: y(data[10].natIdx) + 15 }
    ];
    labelPos.forEach(l => {
        applyTransition(svg.select("." + l.cls), animate && updating).attr("y", l.y);
    });

    function lineTip(d) {
        return `<div class="tooltip-title">Year ${d.year} Growth</div>
            <span style="color:var(--accent-red)">First Nations: <b>${d.fnIdx.toFixed(1)}%</b> (${d.fnRaw.toLocaleString()} cases)</span><br>
            <span style="color:var(--chart-blue)">Non-Indigenous: <b>${d.nonIdx.toFixed(1)}%</b> (${d.nonRaw.toLocaleString()} cases)</span><br>
            <span style="color:var(--chart-orange)">National Total: <b>${d.natIdx.toFixed(1)}%</b> (${d.natRaw.toLocaleString()} cases)</span>`;
    }

    const step = x.step();
    const zones = svg.selectAll(".hover-zone").data(data, d => d.year);
    zones.exit().remove();
    const zonesEnter = zones.enter().append("rect").attr("class", "hover-zone")
        .attr("fill", "transparent").style("cursor", "crosshair")
        .attr("tabindex", "0").attr("role", "button");
    const zonesAll = zonesEnter.merge(zones);

    zonesAll
        .attr("aria-label", d =>
            `${d.year}: First Nations ${d.fnIdx.toFixed(1)}% (${d.fnRaw.toLocaleString()} cases), ` +
            `Non-Indigenous ${d.nonIdx.toFixed(1)}% (${d.nonRaw.toLocaleString()} cases), ` +
            `National ${d.natIdx.toFixed(1)}% (${d.natRaw.toLocaleString()} cases)`)
        .on("mouseover focus", function (e, d) {
            svg.append("line").attr("class", "hover-line").attr("aria-hidden", "true").attr("x1", x(d.year)).attr("x2", x(d.year)).attr("y1", margin.top).attr("y2", height - margin.bottom).attr("stroke", "#94a3b8").attr("stroke-dasharray", "3,3");
            svg.append("circle").attr("class", "hover-dot").attr("aria-hidden", "true").attr("cx", x(d.year)).attr("cy", y(d.fnIdx)).attr("r", 6).attr("fill", "var(--accent-red)").attr("stroke", "#fff").attr("stroke-width", 2);
            svg.append("circle").attr("class", "hover-dot").attr("aria-hidden", "true").attr("cx", x(d.year)).attr("cy", y(d.nonIdx)).attr("r", 6).attr("fill", "var(--chart-blue)").attr("stroke", "#fff").attr("stroke-width", 2);
            svg.append("circle").attr("class", "hover-dot").attr("aria-hidden", "true").attr("cx", x(d.year)).attr("cy", y(d.natIdx)).attr("r", 6).attr("fill", "var(--chart-orange)").attr("stroke", "#fff").attr("stroke-width", 2);
            showChartTip(this, lineTip(d), e);
        })
        .on("mousemove", (e, d) => showTooltip(lineTip(d), e.pageX + 15, e.pageY - 15))
        .on("mouseout blur", function () {
            svg.selectAll(".hover-line, .hover-dot").remove();
            hideTooltip(this);
        });

    applyTransition(zonesAll, animate && updating)
        .attr("x", d => x(d.year) - step / 2)
        .attr("y", margin.top)
        .attr("width", step)
        .attr("height", height - margin.top - margin.bottom);
}

// 2. Population Pyramid Chart (Independent Scales)
function drawPyramidChart(containerId, fState, animate) {
    const isDashboard = containerId.startsWith("dash-canvas-");
    const parent = d3.select("#" + containerId);
    let svg = parent.select("svg");
    const updating = isDashboard && !svg.empty();

    if (!isDashboard || !updating) parent.html("");

    const cohorts = ["0-7", "8-16", "17-25", "26-39", "40-64", "65+"];
    let subset = rawFN.filter(d => d.catType === "Age group");
    if (fState.year !== "All") subset = subset.filter(d => d.year === +fState.year);
    else subset = subset.filter(d => d.year === 2021);

    const data = cohorts.map(c => ({
        group: c,
        fn: d3.sum(subset.filter(d => d.catValue === c && d.status === "First Nations people"), x => x.cases),
        non: d3.sum(subset.filter(d => d.catValue === c && d.status === "Non-Indigenous"), x => x.cases)
    }));

    const y = d3.scaleBand().domain(cohorts).range([height - margin.bottom, margin.top]).padding(0.2);
    const xMaxFn = d3.max(data, d => d.fn) || 1;
    const xMaxNon = d3.max(data, d => d.non) || 1;
    const xL = d3.scaleLinear().domain([0, xMaxFn]).range([width / 2 - 35, margin.left]);
    const xR = d3.scaleLinear().domain([0, xMaxNon]).range([width / 2 + 35, width - margin.right]);
    const fnPatternId = "pattern-fn-" + containerId;

    if (!updating) {
        svg = parent.append("svg").attr("viewBox", `0 0 ${width} ${height}`);
        svg.append("title").text("Population pyramid: hospitalisations by age group, First Nations versus Non-Indigenous");
        svg.append("g").attr("transform", `translate(0,${height - margin.bottom})`).attr("class", "axis axis-left");
        svg.append("g").attr("transform", `translate(0,${height - margin.bottom})`).attr("class", "axis axis-right");
        svg.selectAll(".axis").attr("aria-hidden", "true");

        const patternDefs = svg.append("defs");
        const fnPattern = patternDefs.append("pattern")
            .attr("id", fnPatternId).attr("patternUnits", "userSpaceOnUse").attr("width", 6).attr("height", 6);
        fnPattern.append("rect").attr("width", 6).attr("height", 6).attr("fill", "var(--accent-red)");
        fnPattern.append("path").attr("d", "M0,6 L6,0").attr("stroke", "#070a12").attr("stroke-width", 1.2);

        const legend = svg.append("g").attr("class", "pyramid-legend").attr("transform", `translate(${width - margin.right - 100}, ${margin.top - 30})`).attr("aria-hidden", "true");
        legend.append("rect").attr("x", 0).attr("y", 0).attr("width", 10).attr("height", 10).attr("fill", "url(#" + fnPatternId + ")").attr("rx", 2);
        legend.append("text").attr("x", 15).attr("y", 9).style("fill", "var(--text-muted)").attr("class", "chart-label").text("First Nations (striped)");
        legend.append("rect").attr("x", 0).attr("y", 15).attr("width", 10).attr("height", 10).attr("fill", "var(--chart-blue)").attr("rx", 2);
        legend.append("text").attr("x", 15).attr("y", 24).style("fill", "var(--text-muted)").attr("class", "chart-label").text("Non-Indigenous (solid)");
    }

    applyTransition(svg.select(".axis-left"), animate && updating).call(d3.axisBottom(xL).ticks(4).tickFormat(d3.format("~s")));
    applyTransition(svg.select(".axis-right"), animate && updating).call(d3.axisBottom(xR).ticks(4).tickFormat(d3.format("~s")));

    function bindBarEvents(selection, valueKey, titlePrefix) {
        const tip = d => `<div class="tooltip-title">${titlePrefix} (Age ${d.group})</div>Total: <b>${d[valueKey].toLocaleString()}</b> cases`;
        selection
            .attr("tabindex", "0").attr("role", "button")
            .attr("aria-label", d => `${titlePrefix}, age ${d.group}: ${d[valueKey].toLocaleString()} hospitalisations`)
            .on("mouseover focus", function (e, d) { showChartTip(this, tip(d), e); })
            .on("mousemove", (e, d) => showTooltip(tip(d), e.pageX + 15, e.pageY - 15))
            .on("mouseout blur", function () { hideTooltip(this); });
    }

    const lBars = svg.selectAll(".lBar").data(data, d => d.group);
    lBars.exit().remove();
    const lBarsEnter = lBars.enter().append("rect").attr("class", "dash-bar lBar").attr("fill", "url(#" + fnPatternId + ")");
    bindBarEvents(lBarsEnter.merge(lBars), "fn", "First Nations");
    applyTransition(lBarsEnter.merge(lBars), animate && updating)
        .attr("x", d => xL(d.fn))
        .attr("y", d => y(d.group))
        .attr("width", d => (width / 2 - 35) - xL(d.fn))
        .attr("height", y.bandwidth());

    const rBars = svg.selectAll(".rBar").data(data, d => d.group);
    rBars.exit().remove();
    const rBarsEnter = rBars.enter().append("rect").attr("class", "dash-bar rBar").attr("fill", "var(--chart-blue)");
    bindBarEvents(rBarsEnter.merge(rBars), "non", "Non-Indigenous");
    applyTransition(rBarsEnter.merge(rBars), animate && updating)
        .attr("x", width / 2 + 35)
        .attr("y", d => y(d.group))
        .attr("width", d => xR(d.non) - (width / 2 + 35))
        .attr("height", y.bandwidth());

    const labels = svg.selectAll(".lbl").data(data, d => d.group);
    labels.exit().remove();
    labels.enter().append("text").attr("class", "chart-label lbl")
        .attr("x", width / 2).attr("text-anchor", "middle").style("fill", "var(--text-dark)").style("font-weight", "bold").attr("aria-hidden", "true")
        .merge(labels)
        .text(d => d.group);
    applyTransition(svg.selectAll(".lbl"), animate && updating)
        .attr("y", d => y(d.group) + y.bandwidth() / 2 + 4);
}

// 3. Archimedean Spiral Heatmap
function drawSpiralChart(containerId, fState, animate) {
    const isDashboard = containerId.startsWith("dash-canvas-");
    const parent = d3.select("#" + containerId);
    let svg = parent.select("svg");
    const updating = isDashboard && !svg.empty();

    if (!isDashboard || !updating) parent.html("");

    const subset = filterHospData(fState);
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const vehicles = ["Car", "Motorcycle", "Bicycle", "Pedestrian", "Truck"];
    const gradientId = "spiral-gradient-" + containerId;
    const baseR = 50;
    const rThick = 26;

    const data = [];
    vehicles.forEach((v, vIdx) => {
        months.forEach((m, mIdx) => {
            const count = d3.sum(subset.filter(d => mapVehicle(d.roadUser).includes(v.split("/")[0]) && d.month === m), x => x.cases);
            data.push({ v, vIdx, m, mIdx, val: count, key: v + "|" + m });
        });
    });

    const maxVal = d3.max(data, d => d.val) || 1;
    const color = d3.scaleSequentialLog(d3.interpolateRgb("#0f172a", "#ef4444")).domain([1, maxVal]);
    const segmentFill = d => d.val === 0 ? "rgba(255,255,255,0.02)" : color(d.val);

    function arcPath(d) {
        const offset = (d.mIdx / 12) * (rThick * 0.85);
        const innerR = baseR + (d.vIdx * rThick) + offset;
        const outerR = innerR + rThick - 1;
        return d3.arc().innerRadius(innerR).outerRadius(outerR)
            .startAngle((d.mIdx * 2 * Math.PI) / 12).endAngle(((d.mIdx + 1) * 2 * Math.PI) / 12)();
    }

    if (!updating) {
        svg = parent.append("svg").attr("viewBox", `0 0 600 600`);
        svg.append("title").text("Spiral heatmap: monthly hospitalisations by vehicle type");
        const g = svg.append("g").attr("class", "spiral-root").attr("transform", `translate(300, 300)`);

        months.forEach((m, i) => {
            const ang = ((i + 0.5) * 2 * Math.PI) / 12 - Math.PI / 2;
            const radius = baseR + (vehicles.length * rThick) + 20;
            g.append("text").attr("class", "chart-label spiral-month-label").attr("x", radius * Math.cos(ang)).attr("y", radius * Math.sin(ang) + 4)
                .attr("text-anchor", "middle").style("fill", "var(--text-muted)").style("font-weight", "bold").text(m.substring(0, 3)).attr("aria-hidden", "true");
        });

        vehicles.forEach((v, i) => {
            g.append("text").attr("class", "chart-label spiral-vehicle-label").attr("x", 5).attr("y", -(baseR + (i * rThick) + 12))
                .attr("text-anchor", "start").style("fill", "var(--text-muted)").text(v).attr("aria-hidden", "true");
        });

        const defs = svg.append("defs");
        const gradient = defs.append("linearGradient").attr("id", gradientId).attr("x1", "0%").attr("y1", "0%").attr("x2", "100%").attr("y2", "0%");
        gradient.append("stop").attr("offset", "0%").attr("stop-color", "#0f172a");
        gradient.append("stop").attr("offset", "100%").attr("stop-color", "#ef4444");

        const legendG = g.append("g").attr("class", "spiral-legend").attr("transform", `translate(-100, ${baseR + (vehicles.length * rThick) + 40})`).attr("aria-hidden", "true");
        legendG.append("text").attr("x", 100).attr("y", 0).attr("text-anchor", "middle").style("fill", "var(--text-muted)").attr("class", "chart-label").style("font-weight", "bold").text("Hospitalisation Intensity");
        legendG.append("rect").attr("x", 0).attr("y", 8).attr("width", 200).attr("height", 10).style("fill", "url(#" + gradientId + ")");
        legendG.append("text").attr("x", 0).attr("y", 30).attr("text-anchor", "middle").style("fill", "var(--text-muted)").attr("class", "chart-label").text("Low");
        legendG.append("text").attr("x", 200).attr("y", 30).attr("text-anchor", "middle").style("fill", "var(--text-muted)").attr("class", "chart-label").text("High");
    }

    const g = svg.select(".spiral-root");
    const segments = g.selectAll(".spiral-segment").data(data, d => d.key);
    segments.exit().remove();
    const segmentsEnter = segments.enter().append("path").attr("class", "spiral-segment")
        .attr("d", arcPath)
        .attr("stroke", "var(--panel-bg)").attr("stroke-width", "1.5px")
        .style("cursor", "pointer")
        .attr("tabindex", "0").attr("role", "button");

    const segmentsAll = segmentsEnter.merge(segments);
    segmentsAll
        .attr("aria-label", d => `${d.v}, ${d.m}: ${d.val.toLocaleString()} hospitalisations`)
        .on("mouseover focus", function (e, d) {
            d3.select(this).attr("stroke", "#fff").attr("stroke-width", "2px");
            const tip = `<div class="tooltip-title">${d.v}</div>Month: ${d.m}<br>Cases: <b>${d.val.toLocaleString()}</b>`;
            showChartTip(this, tip, e);
        })
        .on("mousemove", (e, d) => showTooltip(`<div class="tooltip-title">${d.v}</div>Month: ${d.m}<br>Cases: <b>${d.val.toLocaleString()}</b>`, e.pageX + 15, e.pageY - 15))
        .on("mouseout blur", function () {
            d3.select(this).attr("stroke", "var(--panel-bg)").attr("stroke-width", "1.5px");
            hideTooltip(this);
        });

    if (animate && updating) {
        segmentsAll.each(function (d) {
            const node = d3.select(this);
            const prev = node.datum();
            const startVal = prev ? prev.val : d.val;
            node.datum(d);
            node.transition().duration(CHART_TRANSITION_MS).ease(d3.easeCubicInOut)
                .attrTween("fill", () => t => {
                    const v = startVal + t * (d.val - startVal);
                    return v <= 0 ? "rgba(255,255,255,0.02)" : color(Math.max(1, v));
                });
        });
    } else {
        segmentsAll.datum(d => d).attr("fill", segmentFill);
    }
}

// 4. Sankey: Region → Vehicle → Severity
function drawSankeyChart(containerId, fState, animate) {
    const isDashboard = containerId.startsWith("dash-canvas-");
    const parent = d3.select("#" + containerId);
    const existingSvg = parent.select("svg");
    const updating = isDashboard && !existingSvg.empty();

    if (!isDashboard) {
        parent.html("");
    } else if (updating && animate) {
        chartTransition(existingSvg).style("opacity", 0).on("end", () => {
            parent.html("");
            drawSankeyChart(containerId, fState, false);
            chartTransition(parent.select("svg")).style("opacity", 1);
        });
        return;
    } else {
        parent.html("");
    }

    // ── dimensions ──────────────────────────────────────────────────────────
    const W = 860, H = 420;
    const pad = { top: 20, right: 160, bottom: 20, left: 150 };
    const nodeW = 14, nodeGap = 10;

    const svg = parent.append("svg")
        .attr("viewBox", `0 0 ${W} ${H}`)
        .style("overflow", "visible");
    svg.append("title").text("Sankey diagram: trauma flow from region through vehicle type to severity of hospital stay");

    // ── build raw links from filtered data ──────────────────────────────────
    const subset = filterHospData(fState);

    function getSeverity(cases, days) {
        if (!cases) return null;
        const avg = days / cases;
        if (avg < 3) return "Minor Stay (< 3d)";
        if (avg <= 7) return "Moderate Stay (3–7d)";
        return "Severe Stay (> 7d)";
    }

    // Aggregate: region → vehicle → severity → cases+days
    const agg = {};
    subset.forEach(d => {
        const region = d.area;
        const vehicle = mapVehicle(d.roadUser);
        if (vehicle === "Other" || !region || region === "Missing") return;
        const sev = getSeverity(d.cases, d.days);
        if (!sev) return;
        const k = `${region}||${vehicle}||${sev}`;
        if (!agg[k]) agg[k] = { region, vehicle, sev, cases: 0, days: 0 };
        agg[k].cases += d.cases;
        agg[k].days += d.days;
    });

    // ── nodes ────────────────────────────────────────────────────────────────
    const regions = ["Major Cities", "Regional", "Remote"];
    const vehicles = ["Car", "Motorcycle", "Bicycle", "Pedestrian", "Truck"];
    const severities = ["Minor Stay (< 3d)", "Moderate Stay (3–7d)", "Severe Stay (> 7d)"];

    // Colors
    const regionColor = {
        "Major Cities": "var(--chart-blue)",
        "Regional": "var(--chart-orange)",
        "Remote": "var(--accent-red)"
    };
    const vehicleColor = {
        "Car": "#3b82f6",
        "Motorcycle": "#8b5cf6",
        "Bicycle": "#10b981",
        "Pedestrian": "#f59e0b",
        "Truck": "#6b7280"
    };
    const severityColor = {
        "Minor Stay (< 3d)": "var(--chart-blue)",
        "Moderate Stay (3–7d)": "var(--chart-orange)",
        "Severe Stay (> 7d)": "var(--accent-red)"
    };

    // Compute node totals
    const regionTotal = Object.fromEntries(regions.map(r => [r, 0]));
    const vehicleTotal = Object.fromEntries(vehicles.map(v => [v, 0]));
    const severityTotal = Object.fromEntries(severities.map(s => [s, 0]));

    Object.values(agg).forEach(({ region, vehicle, sev, cases }) => {
        if (regionTotal[region] !== undefined) regionTotal[region] += cases;
        if (vehicleTotal[vehicle] !== undefined) vehicleTotal[vehicle] += cases;
        if (severityTotal[sev] !== undefined) severityTotal[sev] += cases;
    });

    const totalCases = d3.sum(regions, r => regionTotal[r]);
    if (totalCases === 0) {
        svg.append("text").attr("x", W / 2).attr("y", H / 2)
            .attr("text-anchor", "middle").attr("class", "chart-label")
            .text("No data for current filter selection.");
        return;
    }

    // ── layout helper: position nodes in a column ────────────────────────────
    function layoutColumn(names, totals, xPos) {
        const usableH = H - pad.top - pad.bottom;
        const totalGap = nodeGap * (names.length - 1);
        const totalBar = usableH - totalGap;
        let y = pad.top;
        return names
            .filter(n => totals[n] > 0)
            .map(name => {
                const barH = Math.max(2, (totals[name] / totalCases) * totalBar);
                const node = { name, x: xPos, y, h: barH, total: totals[name] };
                y += barH + nodeGap;
                return node;
            });
    }

    const colX1 = pad.left;
    const colX2 = W / 2 - nodeW / 2;
    const colX3 = W - pad.right - nodeW;

    const regionNodes = layoutColumn(regions, regionTotal, colX1);
    const vehicleNodes = layoutColumn(vehicles, vehicleTotal, colX2);
    const severityNodes = layoutColumn(severities, severityTotal, colX3);

    const nodeMap = {};
    [...regionNodes, ...vehicleNodes, ...severityNodes].forEach(n => nodeMap[n.name] = n);

    // ── link computation ─────────────────────────────────────────────────────
    // For each node, track running offset for outflow (right) and inflow (left)
    const outOffset = {}; // name → current y offset out
    const inOffset = {}; // name → current y offset in
    [...regionNodes, ...vehicleNodes, ...severityNodes].forEach(n => {
        outOffset[n.name] = 0;
        inOffset[n.name] = 0;
    });

    // Links: Region → Vehicle
    const rv_links = [];
    // Sort by region then vehicle for stable stacking
    regions.forEach(region => {
        vehicles.forEach(vehicle => {
            const cases = d3.sum(
                Object.values(agg).filter(d => d.region === region && d.vehicle === vehicle),
                d => d.cases
            );
            if (cases === 0) return;
            const rNode = nodeMap[region];
            const vNode = nodeMap[vehicle];
            if (!rNode || !vNode) return;
            rv_links.push({ source: rNode, target: vNode, cases, color: regionColor[region] });
        });
    });

    // Links: Vehicle → Severity
    const vs_links = [];
    vehicles.forEach(vehicle => {
        severities.forEach(sev => {
            const cases = d3.sum(
                Object.values(agg).filter(d => d.vehicle === vehicle && d.sev === sev),
                d => d.cases
            );
            if (cases === 0) return;
            const vNode = nodeMap[vehicle];
            const sNode = nodeMap[sev];
            if (!vNode || !sNode) return;
            vs_links.push({ source: vNode, target: sNode, cases, color: vehicleColor[vehicle] });
        });
    });

    // Compute link heights proportional to node height
    function computeLinkGeometry(links) {
        return links.map(link => {
            const { source: s, target: t, cases } = link;
            const srcH = (cases / totalCases) * (H - pad.top - pad.bottom - nodeGap * (regions.length - 1));
            const linkH = Math.max(1, (cases / totalCases) * (H - pad.top - pad.bottom));

            const sy0 = s.y + (outOffset[s.name] / s.total) * s.h;
            const sy1 = sy0 + (cases / s.total) * s.h;
            outOffset[s.name] += cases;

            const ty0 = t.y + (inOffset[t.name] / t.total) * t.h;
            const ty1 = ty0 + (cases / t.total) * t.h;
            inOffset[t.name] += cases;

            return { ...link, sy0, sy1, ty0, ty1 };
        });
    }

    const rvGeom = computeLinkGeometry(rv_links);
    const vsGeom = computeLinkGeometry(vs_links);

    // ── draw links ───────────────────────────────────────────────────────────
    function drawLinks(links, xSrcRight, xTgtLeft) {
        const g = svg.append("g").attr("class", "sankey-links");
        links.forEach(link => {
            const { sy0, sy1, ty0, ty1, color, cases } = link;
            const cx = (xSrcRight + xTgtLeft) / 2;

            const path = `
                M ${xSrcRight} ${sy0}
                C ${cx} ${sy0}, ${cx} ${ty0}, ${xTgtLeft} ${ty0}
                L ${xTgtLeft} ${ty1}
                C ${cx} ${ty1}, ${cx} ${sy1}, ${xSrcRight} ${sy1}
                Z
            `;

            const pct = ((cases / totalCases) * 100).toFixed(1);
            const tipHtml = `
                <div class="tooltip-title">${link.source.name} → ${link.target.name}</div>
                Hospitalisations: <b>${cases.toLocaleString()}</b><br>
                Share of total: <b>${pct}%</b>
            `;
            g.append("path")
                .attr("d", path)
                .attr("fill", color)
                .attr("opacity", 0.25)
                .attr("class", "sankey-link")
                .style("cursor", "pointer")
                .attr("tabindex", "0")
                .attr("role", "button")
                .attr("aria-label", `${link.source.name} to ${link.target.name}: ${cases.toLocaleString()} hospitalisations, ${pct}% of total`)
                .on("mouseover focus", function (e) {
                    d3.select(this).attr("opacity", 0.65);
                    showChartTip(this, tipHtml, e);
                })
                .on("mousemove", e => showTooltip(tipHtml, e.pageX + 15, e.pageY - 15))
                .on("mouseout blur", function () {
                    d3.select(this).attr("opacity", 0.25);
                    hideTooltip(this);
                });
        });
    }

    drawLinks(rvGeom, colX1 + nodeW, colX2);
    drawLinks(vsGeom, colX2 + nodeW, colX3);

    // ── draw nodes ───────────────────────────────────────────────────────────
    function drawNodes(nodes, colorMap, labelSide) {
        nodes.forEach(node => {
            const g = svg.append("g").style("cursor", "pointer");
            const pct = ((node.total / totalCases) * 100).toFixed(1);

            const tipHtml = `
                <div class="tooltip-title">${node.name}</div>
                Hospitalisations: <b>${node.total.toLocaleString()}</b><br>
                Share of total: <b>${pct}%</b>
            `;
            g.append("rect")
                .attr("x", node.x).attr("y", node.y)
                .attr("width", nodeW).attr("height", node.h)
                .attr("fill", colorMap[node.name] || "#94a3b8")
                .attr("rx", 3)
                .attr("tabindex", "0")
                .attr("role", "button")
                .attr("aria-label", `${node.name}: ${node.total.toLocaleString()} hospitalisations, ${pct}% of total`)
                .on("mouseover focus", function (e) {
                    d3.select(this).attr("opacity", 0.8);
                    showChartTip(this, tipHtml, e);
                })
                .on("mousemove", e => showTooltip(tipHtml, e.pageX + 15, e.pageY - 15))
                .on("mouseout blur", function () {
                    d3.select(this).attr("opacity", 1);
                    hideTooltip(this);
                });

            const midY = node.y + node.h / 2;
            const textX = labelSide === "left" ? node.x - 8 :
                labelSide === "right" ? node.x + nodeW + 8 : node.x + nodeW / 2;
            const anchor = labelSide === "left" ? "end" :
                labelSide === "right" ? "start" : "middle";

            g.append("text")
                .attr("x", textX).attr("y", midY - 4)
                .attr("text-anchor", anchor).attr("dominant-baseline", "middle")
                .style("fill", "var(--text-dark)").attr("class", "chart-label").style("font-weight", "700")
                .text(node.name).attr("aria-hidden", "true");

            g.append("text")
                .attr("x", textX).attr("y", midY + 10)
                .attr("text-anchor", anchor).attr("dominant-baseline", "middle")
                .style("fill", "var(--text-muted)").attr("class", "chart-label")
                .text(`${(node.total / 1000).toFixed(1)}k · ${pct}%`).attr("aria-hidden", "true");
        });
    }

    drawNodes(regionNodes, regionColor, "left");
    drawNodes(vehicleNodes, vehicleColor, "right");
    drawNodes(severityNodes, severityColor, "right");

    // ── column header labels ─────────────────────────────────────────────────
    const colHeaders = [
        { label: "Region", x: colX1 + nodeW / 2 },
        { label: "Vehicle Type", x: colX2 + nodeW / 2 },
        { label: "Severity of Stay", x: colX3 + nodeW / 2 },
    ];
    colHeaders.forEach(h => {
        svg.append("text")
            .attr("x", h.x).attr("y", pad.top - 10)
            .attr("text-anchor", "middle")
            .style("fill", "var(--chart-blue)").attr("class", "chart-label")
            .style("font-weight", "800").style("text-transform", "uppercase").style("letter-spacing", "1.5px")
            .text(h.label).attr("aria-hidden", "true");
    });

    const legendX = colX2 - 4;
    const legendY = H - 8;
    const legendItems = Object.entries(vehicleColor);
    const itemW = 90;
    const totalLegW = legendItems.length * itemW;
    const legendStartX = legendX - totalLegW / 2 + nodeW / 2;

    legendItems.forEach(([name, color], i) => {
        const lx = legendStartX + i * itemW;
        svg.append("rect")
            .attr("x", lx).attr("y", legendY - 8)
            .attr("width", 10).attr("height", 10)
            .attr("fill", color).attr("rx", 2).attr("aria-hidden", "true");
        svg.append("text")
            .attr("x", lx + 14).attr("y", legendY + 1)
            .style("fill", "var(--text-muted)").attr("class", "chart-label")
            .text(name).attr("aria-hidden", "true");
    });
}

// --- SCROLLYTELLING ---
function updateScrollyChart(index) {
    const state = { gender: "All", year: "All", region: "All", age: "All", roadUser: "All" };
    if (index === 1 || index === 2) state.year = "2021";
    if (index === 0) drawLineChart("chart-canvas", state);
    else if (index === 1) drawPyramidChart("chart-canvas", state);
    else if (index === 2) drawSpiralChart("chart-canvas", state);
    else if (index === 3) drawSankeyChart("chart-canvas", state);
}

function syncScrollyStep(index, announce) {
    const steps = document.querySelectorAll(".step");
    if (index < 0 || index >= steps.length) return;

    activeScrollyStep = index;
    steps.forEach((s, i) => {
        s.classList.toggle("active", i === index);
        if (i === index) s.setAttribute("aria-current", "step");
        else s.removeAttribute("aria-current");
    });

    if (announce) {
        const status = document.getElementById("scrolly-status");
        const title = steps[index].querySelector("h2");
        if (status && title) status.textContent = `Section ${index + 1} of ${steps.length}: ${title.textContent}`;
    }

    updateScrollyChart(index);
}

function jumpScrollyStep(delta) {
    const steps = document.querySelectorAll(".step");
    const index = activeScrollyStep + delta;
    if (index < 0 || index >= steps.length) return;

    scrollyNavigating = true;
    syncScrollyStep(index, true);
    steps[index].scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => { scrollyNavigating = false; }, 700);
}

function initScrolly() {
    const section = document.querySelector(".scrolly-section");
    if (!section) return;

    section.addEventListener("keydown", (e) => {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
        if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); jumpScrollyStep(1); }
        if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); jumpScrollyStep(-1); }
    });

    window.addEventListener("scroll", () => {
        if (scrollyNavigating) return;
        const steps = document.querySelectorAll(".step");
        let active = 0;
        steps.forEach((s, i) => { if (s.getBoundingClientRect().top <= window.innerHeight / 2) active = i; });
        if (active !== activeScrollyStep) syncScrollyStep(active, false);
    });
}