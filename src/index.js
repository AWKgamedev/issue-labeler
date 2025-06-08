const core = require('@actions/core');
const github = require('@actions/github');
const { Octokit } = require('@octokit/rest');
// Import Type for structured output schema definition
const { GoogleGenerativeAI, Part, Type } = require('@google/generative-ai'); 

async function run() {
    try {
        const githubToken = core.getInput('github-token');
        const aiApiKey = core.getInput('ai-api-key');

        const octokit = new Octokit({ auth: githubToken });

        const payload = github.context.payload;
        const issue = payload.issue;
        const repository = payload.repository;

        if (!issue) {
            core.info('No issue found in the payload. Exiting.');
            return;
        }

        const issueTitle = issue.title;
        const issueBody = issue.body || 'No description provided.';
        const issueNumber = issue.number;
        const owner = repository.owner.login;
        const repo = repository.name;

        core.info(`Processing issue #${issueNumber}: ${issueTitle}`);

        // 1. Get all project labels and their descriptions
        const { data: repoLabels } = await octokit.rest.issues.listLabelsForRepo({
            owner,
            repo,
        });

        let labelsPrompt = 'Existing labels in the project:\n';
        if (repoLabels.length > 0) {
            repoLabels.forEach(label => {
                labelsPrompt += `- Name: "${label.name}", Description: "${label.description || 'No description'}"\n`;
            });
        } else {
            labelsPrompt += 'No existing labels.\n';
        }

        // 2. Construct the prompt for the AI model
        const prompt = `You are an expert GitHub issue labeler. Your task is to analyze an issue and suggest appropriate labels from a given list. If no existing labels seem suitable, suggest new, highly relevant labels.

Here is the issue:
Title: "${issueTitle}"
Body: "${issueBody}"

${labelsPrompt}

Instructions:
- Based on the issue's title and body, suggest up to 3 existing labels that are most relevant.
- If existing labels are not sufficient, suggest up to 2 new, concise, and descriptive labels.
- Provide your response in a JSON array format. Each element in the array should be an object with a 'name' property for the label. If it's a new label, also include a 'description' property.
`;

        core.info('Sending prompt to AI model with structured output request...');

        // Initialize AI model
        const genAI = new GoogleGenerativeAI(aiApiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        // Use generateContent with structured output configuration
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            name: { type: Type.STRING },
                            description: { type: Type.STRING, optional: true } // Description is optional for existing labels
                        },
                        propertyOrdering: ["name", "description"] // Maintain a consistent order
                    }
                }
            },
        });

        // The response.text() will now directly contain the JSON string
        const jsonResponseText = result.response.text(); 
        core.info(`AI Raw JSON Response: ${jsonResponseText}`);

        let suggestedLabels = [];
        try {
            // Directly parse the JSON output from the AI, as it's now guaranteed to be structured
            suggestedLabels = JSON.parse(jsonResponseText);
            if (!Array.isArray(suggestedLabels)) {
                // This case should ideally not happen with structured output, but it's a good safeguard
                throw new Error("AI response was not a JSON array despite schema request.");
            }
        } catch (parseError) {
            // If parsing fails here, it indicates a serious issue with the AI's adherence to the schema
            core.setFailed(`Critical error: Failed to parse structured AI response as JSON: ${parseError.message}. Raw response: ${jsonResponseText}`);
            return;
        }

        const labelsToAdd = [];
        for (const labelData of suggestedLabels) {
            const labelName = labelData.name;
            const labelDescription = labelData.description;

            // Ensure label name is a string and not empty
            if (typeof labelName !== 'string' || labelName.trim() === '') {
                core.warning(`Skipping invalid label data: ${JSON.stringify(labelData)}`);
                continue;
            }

            const existingLabel = repoLabels.find(l => l.name.toLowerCase() === labelName.toLowerCase());

            if (!existingLabel) {
                core.info(`Label "${labelName}" does not exist. Attempting to create it.`);
                try {
                    await octokit.rest.issues.createLabel({
                        owner,
                        repo,
                        name: labelName,
                        color: 'ededed', // Default color, consider making this configurable or AI-suggested
                        description: labelDescription || `AI-suggested label for issue automation`
                    });
                    labelsToAdd.push(labelName);
                    core.info(`Successfully created label "${labelName}".`);
                } catch (createError) {
                    // Check if the error indicates the label already exists (e.g., race condition)
                    if (createError.status === 422 && createError.message.includes('already exists')) {
                        core.warning(`Label "${labelName}" already exists (likely created by another process). Adding to issue.`);
                        labelsToAdd.push(labelName); // Add it if it now exists
                    } else {
                        core.error(`Failed to create label "${labelName}": ${createError.message}`);
                    }
                }
            } else {
                core.info(`Label "${labelName}" already exists.`);
                labelsToAdd.push(labelName);
            }
        }

        if (labelsToAdd.length > 0) {
            core.info(`Adding labels to issue #${issueNumber}: ${labelsToAdd.join(', ')}`);
            await octokit.rest.issues.addLabels({
                owner,
                repo,
                issue_number: issueNumber,
                labels: labelsToAdd,
            });
            core.info(`Labels successfully added to issue #${issueNumber}.`);
            core.setOutput('labels-applied', labelsToAdd.join(','));
        } else {
            core.info('No labels to add to the issue.');
            core.setOutput('labels-applied', '');
        }

    } catch (error) {
        core.setFailed(`Action failed with error: ${error.message}`);
    }
}

run();
