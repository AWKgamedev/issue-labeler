const core = require('@actions/core');
const github = require('@actions/github');
const { Octokit } = require('@octokit/rest');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Generates a random hex color code.
 * @returns {string} A 6-character hex color code without the '#'.
 */
function getRandomColor() {
    return Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
}

async function run() {
    try {
        // --- Get Action Inputs ---
        const githubToken = core.getInput('github-token', { required: true });
        const aiApiKey = core.getInput('ai-api-key', { required: true });
        // New inputs for flexible label amounts with default values
        const maxExistingLabels = core.getInput('max-existing-labels') || '5';
        const maxNewLabels = core.getInput('max-new-labels') || '2';

        // --- Initialize Clients ---
        const octokit = new Octokit({ auth: githubToken });

        // --- Get Context from GitHub Event ---
        const { payload, issue: contextIssue, repo: contextRepo } = github.context;

        // The issue object is only available for issue-related events.
        const issue = payload.issue || contextIssue;
        if (!issue) {
            core.info('This action is running on an event that is not related to an issue. Exiting gracefully.');
            return;
        }

        const owner = contextRepo.owner;
        const repo = contextRepo.repo;
        const issueNumber = issue.number;
        const issueTitle = issue.title;
        // Ensure body is a string, even if it's null or undefined.
        const issueBody = issue.body || 'No description provided.';


        core.info(`Processing issue #${issueNumber}: ${issueTitle}`);

        // --- 1. Fetch Existing Repository Labels ---
        core.info('Fetching existing labels from the repository...');
        const { data: repoLabels } = await octokit.rest.issues.listLabelsForRepo({
            owner,
            repo,
        });

        let labelsPromptSection = 'No existing labels found in the project.\n';
        if (repoLabels.length > 0) {
            labelsPromptSection = 'Here is a list of all existing labels in the project. You should strongly prefer these:\n';
            repoLabels.forEach(label => {
                labelsPromptSection += `- Name: "${label.name}", Description: "${label.description || 'No description'}"\n`;
            });
        }

        // --- 2. Construct the Enhanced Prompt for the AI Model ---
        // This new prompt is more directive to guide the AI's behavior.
        const prompt = `
You are an expert GitHub issue labeler. Your task is to analyze a GitHub issue and assign the most appropriate labels based on a list of existing labels from the repository.

**Primary Goal:** Maximize the use of EXISTING labels.

**Issue Details:**
- Title: "${issueTitle}"
- Body: "${issueBody}"

**Available Repository Labels (Name and Description):**
${labelsPromptSection}

**Instructions:**
1.  **Analyze and Match:** Carefully review the issue's title and body. Compare its content and intent against the list of available repository labels.
2.  **Prioritize Existing Labels:** Your main goal is to select the most relevant labels from the existing list. Suggest up to ${maxExistingLabels} existing labels.
3.  **Suggest New Labels (Only if Absolutely Necessary):**
    - You may only suggest a new label if no combination of existing labels can accurately categorize the issue.
    - Do NOT create a new label that is just a minor variation of an existing one.
    - Before creating a new label, you MUST analyze the naming convention and style of existing labels (e.g., 'type: area', 'status: in-progress', 'priority: high'). New labels MUST follow these established patterns.
    - You may suggest a maximum of ${maxNewLabels} new labels.
    - Every new label object in your response MUST include a 'description' property that clearly explains its purpose.
4.  **Output Format:** Your response MUST be a valid JSON array of objects. Each object must have a 'name' key. For NEW labels, it MUST also include a 'description' key. Do not wrap the JSON in markdown backticks.

**Example JSON Output:**
[
  { "name": "bug" },
  { "name": "documentation" },
  { "name": "scope:organization", "description": "Task related to the project's organization and management." }
]
`;

        core.info('Sending enhanced prompt to AI model...');

        // --- 3. Call the Generative AI Model ---
        const genAI = new GoogleGenerativeAI(aiApiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const result = await model.generateContent(prompt);
        const response = result.response;
        // Clean up the response text to remove potential markdown wrappers.
        const text = response.text().replace(/```json\n|```/g, '').trim();

        core.info(`AI Response: ${text}`);

        // --- 4. Parse AI Response and Prepare Labels ---
        let suggestedLabels = [];
        try {
            suggestedLabels = JSON.parse(text);
            if (!Array.isArray(suggestedLabels)) {
                throw new Error("AI response was valid JSON but not an array.");
            }
        } catch (parseError) {
            core.setFailed(`Failed to parse AI response as a JSON array: ${parseError.message}. Raw response: "${text}"`);
            return; // Stop execution if we can't get a valid label list.
        }

        const labelsToAdd = [];
        for (const labelData of suggestedLabels) {
            if (!labelData.name) continue; // Skip if a label object has no name.

            const labelName = labelData.name;
            const labelDescription = labelData.description; // Will be undefined if not provided

            // Check if the label already exists (case-insensitive search).
            const existingLabel = repoLabels.find(l => l.name.toLowerCase() === labelName.toLowerCase());

            if (!existingLabel) {
                // --- Create New Label if it Doesn't Exist ---
                core.info(`Label "${labelName}" does not exist. Creating it.`);
                try {
                    await octokit.rest.issues.createLabel({
                        owner,
                        repo,
                        name: labelName,
                        color: getRandomColor(), // Assign a random color
                        // Use the AI's description, or provide a clear fallback if it was missing.
                        description: labelDescription || `AI suggested label: ${labelName}`
                    });
                    labelsToAdd.push(labelName);
                    core.info(`Successfully created label "${labelName}".`);
                } catch (createError) {
                    // Handle cases where the label might have been created in a race condition.
                    if (createError.message.includes('already_exists')) {
                        core.warning(`Label "${labelName}" already existed upon creation attempt (race condition). Adding it anyway.`);
                        labelsToAdd.push(labelName);
                    } else {
                        core.error(`Failed to create label "${labelName}": ${createError.message}`);
                    }
                }
            } else {
                // --- Add Existing Label ---
                core.info(`Label "${labelName}" already exists. Adding it.`);
                labelsToAdd.push(labelName);
            }
        }

        // --- 5. Apply Labels to the Issue ---
        if (labelsToAdd.length > 0) {
            const uniqueLabelsToAdd = [...new Set(labelsToAdd)]; // Ensure no duplicates
            core.info(`Adding labels to issue #${issueNumber}: ${uniqueLabelsToAdd.join(', ')}`);
            await octokit.rest.issues.addLabels({
                owner,
                repo,
                issue_number: issueNumber,
                labels: uniqueLabelsToAdd,
            });
            core.info(`Labels successfully added to issue #${issueNumber}.`);
            core.setOutput('labels-applied', uniqueLabelsToAdd.join(','));
        } else {
            core.info('No labels to add to the issue.');
            core.setOutput('labels-applied', '');
        }

    } catch (error) {
        core.setFailed(`Action failed with error: ${error.message}`);
    }
}

run();
